#!/usr/bin/env bun
/**
 * GeminiClient.ts -- the generic Gemini provider (implements ProviderClient).
 *
 * Owns ALL Gemini-API interaction on top of @google/genai. Task-agnostic: it knows
 * nothing about what the call is for -- callers pass a prompt and an optional response
 * schema. It is consumed by:
 *   - the dispatcher (dispatch.ts), which routes the "gemini" vendor name to it
 *   - the shared CLI runner (`bun GeminiClient.ts --prompt ...`)
 *   - any program importing it directly for one-off calls
 *
 * Design rules honored here:
 *   - LAZY/dynamic SDK import (never a top-level static import) so ensureDeps() can
 *     report a missing tree before the SDK is loaded.
 *   - Env resolution: config.loadEnv() hydrates process.env from the .env source(s),
 *     then the key is read uniformly from process.env. Never log the key.
 *   - No fallback EVER. Any failure -> structured ErrorVerdict, never another model.
 *   - Budget: gate (lock-free) -> call -> record. Never hold the lock across the call.
 *
 * toolset-version: 0.1.0
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { CallOpts, CallResult, ErrorVerdict, ThinkingModes, CliOptSpec } from "../core/ProviderClient.ts";
import { ProviderClient, CliUsageError } from "../core/ProviderClient.ts";
import { loadEnv } from "../core/config.ts";
import {
  readBudget,
  hasHeadroom,
  recordRequest,
  record429,
  maxBundleTokensFor,
  mapModelNames,
  thinkingModesFor,
} from "./GeminiBudget.ts";

// import.meta.dirname is the Node-standard name (bun supports it identically to its
// import.meta.dir); tsc knows it without bun-types, so no extra dep.
const NODE_MODULES = join(import.meta.dirname, "node_modules");
const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_TIMEOUT_MS = 120_000;

// Standard-tier pricing (USD per 1M tokens); thinking billed as output. Used for a
// rough cost estimate on the line; free tier is $0 but we record the would-be cost.
const PRICE_INPUT_PER_1M = 1.5;
const PRICE_OUTPUT_PER_1M = 9.0;

// ---------------------------------------------------------------------------
// Key resolution. config.loadEnv() hydrates process.env from the .env source(s)
// per the documented precedence ladder, so this vendor reads the key UNIFORMLY from
// process.env -- it never reads a .env file itself. Never log the key.
// ---------------------------------------------------------------------------
interface KeyResolution {
  key: string;
  source: string;
}

function resolveKey(): KeyResolution | null {
  // Populate process.env from .env file(s) first (gap-fill default file + optional
  // override file). After this, the key -- wherever it came from (shell export or a
  // .env file) -- is simply a process.env lookup.
  loadEnv();

  const fromGemini = process.env.GEMINI_API_KEY;
  const fromGoogle = process.env.GOOGLE_API_KEY;
  if (fromGemini && fromGoogle && fromGemini !== fromGoogle) {
    // Precedence footgun: GOOGLE_API_KEY also recognized by the SDK; warn so a stale
    // one is not silently used. We deliberately use GEMINI_API_KEY when both differ.
    process.stderr.write(
      "[GeminiClient] both GEMINI_API_KEY and GOOGLE_API_KEY set and differ; using GEMINI_API_KEY\n",
    );
  }
  if (fromGemini) return { key: fromGemini, source: "env:GEMINI_API_KEY" };
  if (fromGoogle) return { key: fromGoogle, source: "env:GOOGLE_API_KEY" };
  return null;
}

// ---------------------------------------------------------------------------
// ensureDeps -- the node_modules bootstrap. DETECT-ONLY: if the tree is absent we
// return setup-required rather than auto-installing (a missing dep should be visible,
// not silently fetched). The SDK is imported LAZILY only after this passes.
// ---------------------------------------------------------------------------
function ensureDeps(): ErrorVerdict | null {
  // Check the WHOLE third-party surface, not just the SDK. proper-lockfile is a lazy
  // import inside GeminiBudget (so the module graph loads deps-absent), which means a
  // missing proper-lockfile no longer crashes at load -- it would surface late, inside
  // the budget lock. Detecting it here gives one clean setup-required up front instead.
  // node_modules layout: scoped pkg under @google/genai, flat pkg under proper-lockfile.
  const missing: string[] = [];
  if (!existsSync(NODE_MODULES) || !existsSync(join(NODE_MODULES, "@google", "genai"))) {
    missing.push("@google/genai");
  }
  if (!existsSync(join(NODE_MODULES, "proper-lockfile"))) {
    missing.push("proper-lockfile");
  }
  if (missing.length > 0) {
    // Report only WHAT is missing -- not the remedy. How to install is the caller's
    // call (run `bun install` in this dir); baking a command into tool output would
    // hardcode install policy the tool has no business owning.
    return {
      verdict: "setup-required",
      reason: `gemini toolset deps not installed (missing: ${missing.join(", ")}); run \`bun install\` in this directory`,
    };
  }
  return null;
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens / 1_000_000) * PRICE_INPUT_PER_1M +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_1M;
  return +usd.toFixed(6);
}

// Parse the RetryInfo retry-delay (e.g. "37s") out of a Gemini 429 error body, if present.
function parseRetryAfterMs(message: string): number | undefined {
  const m = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m?.[1]) return Math.round(parseFloat(m[1]) * 1000);
  return undefined;
}

// Map an HTTP status from an ApiError to a structured ErrorVerdict.
function classifyStatus(status: number, message: string): ErrorVerdict {
  if (status === 400 || status === 401 || status === 403) {
    // Auth / bad-key / permission -- the user must fix the key in AI Studio. NOT
    // transient. Name the status; never echo the key.
    return {
      verdict: "setup-required",
      reason: `Gemini auth error (HTTP ${status}): key invalid or lacking permission. Fix in AI Studio (https://aistudio.google.com/apikey).`,
    };
  }
  if (status === 429) {
    return {
      verdict: "rate-limited",
      reason: `Gemini rate limit (HTTP 429).`,
      retry_after_ms: parseRetryAfterMs(message),
    };
  }
  if (status === 404) {
    // Model not found -- a live-call error, surfaced as a reason (the model name was bad).
    return { verdict: "unavailable", reason: `Gemini model not found (HTTP 404).` };
  }
  // 5xx, timeouts, anything else -> transient/unknown.
  return { verdict: "unavailable", reason: `Gemini error (HTTP ${status}).` };
}

export class GeminiClient extends ProviderClient {
  readonly provider = "gemini";
  // NOT field-initialized: parseCliOpts() (called after super()) sets these. A field
  // initializer would run after super() and clobber what parseCliOpts set.
  private model!: string;
  private timeoutMs!: number;

  /** Gemini's own CLI flags, beyond the common set. (--model is COMMON -- the runner reads
   *  it for the thinking-modes query -- so only --timeout is vendor-specific here.) */
  protected static override vendorCliOpts(): CliOptSpec[] {
    return [
      { flag: "--timeout", takesValue: true, description: `Call timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}).` },
    ];
  }

  constructor(argv: string[]) {
    super(argv);          // base parses common flags (incl. --model) into this.common; rejects unknown
    this.parseCliOpts();  // subclass: validate + apply --model / --timeout from the parsed flags
  }

  /**
   * Validate + apply Gemini's construction flags from the single base parse. No re-parse,
   * no argv: --model comes from this.common (it is a COMMON flag); --timeout comes via
   * this.vendorFlag() (a VENDOR flag the base parsed but did not decompose into this.common).
   * Throws CliUsageError on bad input.
   */
  private parseCliOpts(): void {
    // --model: common flag, already in this.common. Validate against the available set.
    const model = this.common.model;
    if (model !== undefined) {
      const available = mapModelNames();
      if (available.length > 0 && !available.includes(model)) {
        throw new CliUsageError(
          `--model "${model}" not in the available set: ${available.join(", ")}`,
        );
      }
    }
    this.model = model ?? DEFAULT_MODEL;

    // --timeout: vendor flag. The base parsed it (it was in the combined spec) but did not
    // store it in this.common (which is common-only). Re-read it from the base's stash.
    const rawTimeout = this.vendorFlag("timeout");
    if (rawTimeout !== undefined) {
      const n = Number(rawTimeout);
      if (!Number.isFinite(n) || n <= 0) {
        throw new CliUsageError(`--timeout must be a positive number of milliseconds, got "${rawTimeout}"`);
      }
      this.timeoutMs = n;
    } else {
      this.timeoutMs = DEFAULT_TIMEOUT_MS;
    }
  }

  /**
   * Discoverable per-model bundle ceiling in tokens (ProviderClient contract).
   * Gemini owns its limit knowledge via gemini-tier-limits.json: returns
   * min(input_token_limit, tpm) for the model, or a default if unknown. The
   * caller calls this to cap its input without knowing Gemini specifics.
   */
  maxBundleTokens(model: string): number {
    return maxBundleTokensFor(model);
  }

  /**
   * The thinking modes for a model (ProviderClient contract). Omit `model` to
   * report the modes for this client's default model. Curated (no Gemini API lists
   * modes -- models.get returns only `thinking:true`); see gemini-tier-limits.json.
   * Returns kind:"none" for models with no thinking control (e.g. Gemma).
   */
  thinkingModes(model?: string): ThinkingModes {
    return thinkingModesFor(model ?? this.model);
  }

  /**
   * Are the gemini toolset's deps installed on this machine? (ProviderClient
   * contract.) Delegates to the same ensureDeps() check call() uses internally, so
   * a caller's early gate and the call()-time backstop agree exactly. Returns null
   * when ready, or setup-required when not.
   */
  depsReady(): ErrorVerdict | null {
    return ensureDeps();
  }

  /** Is Gemini configured? -> does an API key resolve (env, or a .env file via loadEnv). */
  async isConfigured(): Promise<{ configured: boolean; reason: string }> {
    const key = resolveKey();
    return key
      ? { configured: true, reason: `key resolved (${key.source})` }
      : { configured: false, reason: "GEMINI_API_KEY not set (env or a .env file)" };
  }

  /** Curated model set: the default + the models in the limits map. */
  models(): { default: string; available: string[] } {
    const available = mapModelNames();
    return {
      default: DEFAULT_MODEL,
      // Ensure the default is listed even if the map is somehow missing it.
      available: available.includes(DEFAULT_MODEL) ? available : [DEFAULT_MODEL, ...available],
    };
  }

  async call(opts: CallOpts): Promise<CallResult | ErrorVerdict> {
    const now = new Date();

    // 1. Deps present? (detect-only; lazy import follows)
    const depErr = ensureDeps();
    if (depErr) return depErr;

    // 2. Key resolves? A missing key is user-fixable (set the env var or .env), not a
    //    transient condition -- so it is "setup-required", matching the ErrorVerdict
    //    taxonomy (cf. missing deps above). NOT "unavailable" (that is for transient faults).
    const resolved = resolveKey();
    if (!resolved) {
      return { verdict: "setup-required", reason: "GEMINI_API_KEY not set (env or a .env file)" };
    }

    // 3. Budget gate (lock-free read; NOT authoritative -- check-then-act is
    //    deliberately racy, the residual is tolerated). Uses the EFFECTIVE limit
    //    (revealed-sidecar wins, else believed-map, else null). Deny only on a
    //    KNOWN-exhausted limit.
    const budget = await readBudget(this.model, now);
    const head = await hasHeadroom(budget);
    if (!head.ok) {
      return {
        verdict: "rate-limited",
        reason: `Gemini RPD budget exhausted (${budget.rpd_used}/${head.limit} today for ${this.model}).`,
      };
    }

    // 4. Lazy SDK import (only after ensureDeps passed).
    let GoogleGenAI: typeof import("@google/genai").GoogleGenAI;
    try {
      ({ GoogleGenAI } = await import("@google/genai"));
    } catch (e) {
      return {
        verdict: "setup-required",
        reason: `Gemini SDK import failed: ${(e as Error).message.slice(0, 120)}`,
        anomaly: true,
      };
    }

    // 5. The call, with our own timeout (the caller may pass no signal).
    const ai = new GoogleGenAI({ apiKey: resolved.key });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = opts.signal ?? controller.signal;

    const contents = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n${opts.userPrompt}`
      : opts.userPrompt;

    // Thinking config is per-model (curated). For kind:"none" (e.g. Gemma) we send
    // NO thinkingConfig -- the model rejects both thinkingLevel and thinkingBudget
    // (verified: HTTP 400). For kind:"level" we send our curated default when the
    // caller specifies none (NOT a hardcoded "medium" -- flash-lite's own default is
    // minimal, but our policy default is medium, expressed in the curated map). An
    // explicit but unsupported level is a caller error, surfaced before the call.
    const modes = thinkingModesFor(this.model);
    const config: Record<string, unknown> = { abortSignal: signal };
    if (modes.kind === "level") {
      const level = opts.thinkingLevel ?? modes.default;
      if (opts.thinkingLevel && !modes.available.includes(opts.thinkingLevel)) {
        clearTimeout(timer);
        return {
          verdict: "error",
          reason: `thinking level "${opts.thinkingLevel}" not supported for ${this.model} (supported: ${modes.available.join(", ")})`,
        };
      }
      config.thinkingConfig = { thinkingLevel: level, includeThoughts: false };
    } else if (modes.kind === "budget") {
      // No curated budget-kind model in v1; if one is added, map opts.thinkingLevel
      // (a numeric string) to thinkingBudget here. Until then, send no thinkingConfig.
    }
    // kind === "none": send no thinkingConfig (the model has no thinking control).
    if (opts.responseSchema) {
      config.responseMimeType = "application/json";
      config.responseSchema = opts.responseSchema;
    }

    try {
      const r = await ai.models.generateContent({ model: this.model, contents, config });
      clearTimeout(timer);

      const text = r.text ?? "";
      const usage = r.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;
      const thoughtTokens = usage?.thoughtsTokenCount ?? 0;
      const tokensUsed = usage?.totalTokenCount ?? inputTokens + outputTokens + thoughtTokens;
      const modelUsed = r.modelVersion ?? this.model;

      let json: unknown;
      if (opts.responseSchema) {
        try {
          json = JSON.parse(text);
        } catch {
          // Schema requested but text was not valid JSON -> treat as a malformed
          // remote response (the caller would otherwise get a misleading empty verdict).
          await recordRequest(this.model, now); // a call DID happen (tokens spent)
          return {
            verdict: "unavailable",
            reason: "Gemini returned non-JSON despite responseSchema (malformed response).",
          };
        }
      }

      // Successful call -> record one request against the daily budget. If the write
      // was skipped (lock contention / preserved corrupt file), surface the note --
      // the call still succeeded, the count may just be one under.
      const recorded = await recordRequest(this.model, now);

      const result: CallResult = { text, tokensUsed, modelUsed };
      if (json !== undefined) result.json = json;
      if (!recorded.recorded && recorded.note) result.notes = [recorded.note];
      // CallResult has no cost field; a caller computes cost from tokens if it wants
      // one. We surface tokens.
      void estimateCost; // retained: a caller may compute its own; client surfaces tokens
      return result;
    } catch (e) {
      clearTimeout(timer);

      // Abort -> unavailable. Check the EFFECTIVE signal (the one we actually passed
      // to the SDK), not just our timeout controller: a caller-supplied opts.signal
      // aborting must be recognized as cancellation, not misclassified as a generic
      // transport error. Distinguish the two for an accurate reason string.
      if (signal.aborted) {
        const reason = opts.signal?.aborted
          ? "caller cancelled the request"
          : `timed out after ${this.timeoutMs}ms`;
        return { verdict: "unavailable", reason: `Gemini call ${reason}.` };
      }

      // ApiError carries an HTTP status; classify it.
      const err = e as { name?: string; status?: number; message?: string };
      const message = err.message ?? String(e);
      if (typeof err.status === "number") {
        const verdict = classifyStatus(err.status, message);
        // On a 429, learn the limit if the body reveals it, and stamp last_429.
        if (verdict.verdict === "rate-limited") {
          await record429(this.model, now); // limit-learning from body deferred (parse when known)
        }
        return verdict;
      }

      // Network / DNS / unknown -> unavailable (transport).
      return { verdict: "unavailable", reason: `Gemini call failed: ${message.slice(0, 160)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry. The shared ProviderClient.runAsCli builds this client (`new this(argv)`),
// runs the CLI, catches CliUsageError -> exit 2, and exits. All the logic is inherited;
// this is the one irreducible per-vendor line (import.meta.main is per-launched-file and
// cannot be inherited). `bun GeminiClient.ts --prompt "..." [--model ...] ...`
// ---------------------------------------------------------------------------
if (import.meta.main) await GeminiClient.runAsCli(process.argv, "bun GeminiClient.ts");
