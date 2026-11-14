#!/usr/bin/env bun
/**
 * MistralClient.ts -- the generic Mistral provider (implements ProviderClient).
 *
 * Talks to Mistral's chat completions REST API with plain fetch, through the transport
 * seam in MistralTransport.ts (the only network code). Task-agnostic: callers pass a
 * prompt and an optional response schema. Serves Mistral's own models and the
 * third-party models Mistral resells on the same endpoint (see mistral-models.json).
 *
 * Consumed by:
 *   - the dispatcher (dispatch.ts), which routes the "mistral" vendor name here
 *   - the shared CLI runner (`bun MistralClient.ts --prompt ...`)
 *   - any program importing it directly for one-off calls
 *
 * Design rules honored here:
 *   - No runtime deps: depsReady() is always null. (An SDK, if adopted later, plugs in
 *     behind the transport seam and must be lazy-imported inside call().)
 *   - Env resolution: config.loadEnv() hydrates process.env; the key is read from
 *     process.env.MISTRAL_API_KEY (Mistral's own name for it). Never log the key.
 *   - No fallback EVER, and no retries. Any failure -> structured ErrorVerdict.
 *   - Reasoning traces (thinking chunks) are dropped; only the answer text is returned.
 *
 * API facts (docs.mistral.ai, checked 2026-11-11): endpoint + shape from
 * inference/conversations/chat-completion; response_format json_schema from
 * structured-output/custom; reasoning_effort + thinking chunks from
 * inference/conversations/reasoning; status codes + Retry-After from resources/error-glossary.
 *
 * toolset-version: 0.1.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallOpts, CallResult, ErrorVerdict, ThinkingModes, CliOptSpec, ModelSet } from "../core/ProviderClient.ts";
import { ProviderClient, CliUsageError, provenanceProblem } from "../core/ProviderClient.ts";
import { loadEnv } from "../core/config.ts";
import { fetchTransport, type MistralTransport, type TransportResponse } from "./MistralTransport.ts";

export const MISTRAL_CHAT_URL = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 180_000;
const CATALOG_PATH = join(import.meta.dirname, "mistral-models.json");
const KEY_VAR = "MISTRAL_API_KEY";

// ---------------------------------------------------------------------------
// Transport injection. Tests (and any caller wanting instrumentation) swap the transport;
// passing null restores the default fetch transport.
// ---------------------------------------------------------------------------
let activeTransport: MistralTransport = fetchTransport;

export function setMistralTransport(t: MistralTransport | null): void {
  activeTransport = t ?? fetchTransport;
}

// ---------------------------------------------------------------------------
// Curated catalog (mistral-models.json). Ships with the code; read once, cached. A
// missing or malformed catalog is a packaging bug, so it throws rather than degrading.
// ---------------------------------------------------------------------------
interface CatalogModel {
  lineage: string;
  host: string;
  context_tokens: number;
  bundle_tokens: number;
  thinking: ThinkingModes;
}

interface Catalog {
  default: string;
  models: Record<string, CatalogModel>;
}

let catalogCache: Catalog | null = null;

function catalog(): Catalog {
  if (catalogCache) {
    return catalogCache;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`mistral-models.json could not be read or parsed at ${CATALOG_PATH}: ${(e as Error).message}`);
  }
  catalogCache = validateCatalog(parsed, CATALOG_PATH);
  return catalogCache;
}

/**
 * Check a parsed catalog's shape and return it typed. Throws on a missing "models" object,
 * a "default" that names no model, or a model without a non-empty lineage and host.
 * Exported so the shape rules can be tested against fixtures, not just the shipped file.
 */
export function validateCatalog(parsed: unknown, source: string): Catalog {
  const c = parsed as Partial<Catalog>;
  if (typeof c.default !== "string" || !c.models || typeof c.models !== "object" || !c.models[c.default]) {
    throw new Error(`mistral-models.json (${source}) needs a "models" object and a "default" naming one of them.`);
  }
  const problem = provenanceProblem(c.models);
  if (problem !== null) {
    throw new Error(`mistral-models.json (${source}): ${problem}.`);
  }
  return c as Catalog;
}

const NO_THINKING: ThinkingModes = { kind: "none", default: "", available: [] };

function thinkingModesFor(model: string): ThinkingModes {
  // kind "none" is reachable only for an unknown model (or a future catalog entry with no
  // reasoning control); every current catalog model has documented levels.
  return catalog().models[model]?.thinking ?? NO_THINKING;
}

// ---------------------------------------------------------------------------
// Key resolution. Never log or echo the key.
// ---------------------------------------------------------------------------
function resolveKey(): { key: string; source: string } | null {
  loadEnv();
  const key = process.env[KEY_VAR];
  return key ? { key, source: `env:${KEY_VAR}` } : null;
}

// ---------------------------------------------------------------------------
// Request/response helpers (pure).
// ---------------------------------------------------------------------------

/** json_schema.name from the schema's title: [a-zA-Z0-9_-] only, max 64; else "response". */
function schemaName(schema: object): string {
  const title = (schema as { title?: unknown }).title;
  if (typeof title !== "string") {
    return "response";
  }
  const name = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return name === "" ? "response" : name;
}

/**
 * The answer text from message.content: a plain string, or the concatenated top-level
 * `text` chunks of a chunk list. `thinking` chunks (reasoning traces) are dropped.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let out = "";
  for (const chunk of content) {
    const c = chunk as { type?: unknown; text?: unknown } | null;
    if (c && c.type === "text" && typeof c.text === "string") {
      out += c.text;
    }
  }
  return out;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP-date. Undefined if absent/unparseable. */
function parseRetryAfterMs(header: string | undefined): number | undefined {
  if (header === undefined) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(parseFloat(trimmed) * 1000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, at - Date.now());
}

/**
 * A short human-readable detail from a Mistral error body. Shapes seen: a string
 * `message` (+ optional `param`); a validation `detail` list either top-level or nested
 * inside `message` (live 422s nest it: `{"message":{"detail":[...]}}`); else the raw text.
 */
function errorDetail(res: TransportResponse): string {
  const j = res.json as { message?: unknown; param?: unknown; detail?: unknown } | null;
  const nested = j && j.message && typeof j.message === "object" ? (j.message as { detail?: unknown }).detail : undefined;
  const detailList = j && Array.isArray(j.detail) ? j.detail : (Array.isArray(nested) ? nested : undefined);
  let detail = "";
  if (j && typeof j.message === "string") {
    detail = j.message;
    if (typeof j.param === "string" && j.param !== "") {
      detail += ` (param: ${j.param})`;
    }
  } else if (detailList) {
    detail = detailList
      .map((d) => {
        const item = d as { loc?: unknown; msg?: unknown };
        const loc = Array.isArray(item.loc) ? item.loc.join(".") : "";
        const msg = typeof item.msg === "string" ? item.msg : JSON.stringify(d);
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join("; ");
  } else {
    detail = res.rawText;
  }
  return detail.slice(0, 200);
}

/** Map a non-2xx response to an ErrorVerdict (docs: resources/error-glossary). */
function classifyStatus(res: TransportResponse, model: string): ErrorVerdict {
  const status = res.status;
  if (status === 401) {
    return { verdict: "setup-required", reason: `Mistral auth error (HTTP 401): ${KEY_VAR} missing, invalid, or expired.` };
  }
  if (status === 403) {
    return {
      verdict: "setup-required",
      reason: `Mistral permission error (HTTP 403) for model ${model}: the account or plan may not include this model.`,
    };
  }
  if (status === 404) {
    return { verdict: "unavailable", reason: `Mistral model or endpoint not found (HTTP 404) for model ${model}.` };
  }
  if (status === 429) {
    const v: ErrorVerdict = { verdict: "rate-limited", reason: "Mistral rate limit (HTTP 429)." };
    const retry = parseRetryAfterMs(res.headers["retry-after"]);
    if (retry !== undefined) {
      v.retry_after_ms = retry;
    }
    return v;
  }
  if (status === 400 || status === 422) {
    // The request itself was rejected: a bug in how we built it, so surface it as an anomaly.
    return { verdict: "error", reason: `Mistral rejected the request (HTTP ${status}): ${errorDetail(res)}`, anomaly: true };
  }
  if (status >= 500) {
    return { verdict: "unavailable", reason: `Mistral server error (HTTP ${status}).` };
  }
  return { verdict: "error", reason: `Mistral unexpected response (HTTP ${status}): ${errorDetail(res)}`, anomaly: true };
}

export class MistralClient extends ProviderClient {
  readonly provider = "mistral";
  // NOT field-initialized: parseCliOpts() (called after super()) sets these. A field
  // initializer would run after super() and clobber what parseCliOpts set.
  private model!: string;
  private timeoutMs!: number;

  /** Mistral's own CLI flags, beyond the common set (--model is common). */
  protected static override vendorCliOpts(): CliOptSpec[] {
    return [
      { flag: "--timeout", takesValue: true, description: `Call timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}).` },
    ];
  }

  constructor(argv: string[]) {
    super(argv);
    this.parseCliOpts();
  }

  /** Validate + apply --model (common) and --timeout (vendor). Throws CliUsageError. */
  private parseCliOpts(): void {
    const models = catalog().models;
    const model = this.common.model;
    if (model !== undefined && !models[model]) {
      throw new CliUsageError(`--model "${model}" not in the available set: ${Object.keys(models).join(", ")}`);
    }
    this.model = model ?? catalog().default;

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

  maxBundleTokens(model: string): number {
    return catalog().models[model]?.bundle_tokens ?? catalog().models[catalog().default]!.bundle_tokens;
  }

  thinkingModes(model?: string): ThinkingModes {
    return thinkingModesFor(model ?? this.model);
  }

  depsReady(): ErrorVerdict | null {
    return null;
  }

  async isConfigured(): Promise<{ configured: boolean; reason: string }> {
    const key = resolveKey();
    return key
      ? { configured: true, reason: `key resolved (${key.source})` }
      : { configured: false, reason: `${KEY_VAR} not set (env or a .env file)` };
  }

  models(): ModelSet {
    const c = catalog();
    const models: ModelSet["models"] = {};
    for (const [id, m] of Object.entries(c.models)) {
      models[id] = { lineage: m.lineage, host: m.host };
    }
    return { default: c.default, available: Object.keys(c.models), models };
  }

  async call(opts: CallOpts): Promise<CallResult | ErrorVerdict> {
    // 1. Key resolves? Missing is user-fixable -> setup-required.
    const resolved = resolveKey();
    if (!resolved) {
      return { verdict: "setup-required", reason: `${KEY_VAR} not set (env or a .env file)` };
    }

    // 2. Reasoning effort, validated against the model's documented levels before any call.
    const modes = thinkingModesFor(this.model);
    const body: Record<string, unknown> = { model: this.model };
    if (modes.kind === "level") {
      if (opts.thinkingLevel !== undefined && !modes.available.includes(opts.thinkingLevel)) {
        return {
          verdict: "error",
          reason: `thinking level "${opts.thinkingLevel}" not supported for ${this.model} (supported: ${modes.available.join(", ")})`,
        };
      }
      body.reasoning_effort = opts.thinkingLevel ?? modes.default;
    } else if (opts.thinkingLevel !== undefined) {
      return { verdict: "error", reason: `${this.model} has no reasoning control; do not pass a thinking level` };
    }

    // 3. Messages: a real system message when given (not concatenated into the prompt).
    const messages: { role: string; content: string }[] = [];
    if (opts.systemPrompt !== undefined) {
      messages.push({ role: "system", content: opts.systemPrompt });
    }
    messages.push({ role: "user", content: opts.userPrompt });
    body.messages = messages;

    if (opts.responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: schemaName(opts.responseSchema), schema: opts.responseSchema, strict: true },
      };
    }

    // 4. The call, under our timeout AND any caller signal (either aborts it).
    const timer = new AbortController();
    const timeoutId = setTimeout(() => timer.abort(), this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timer.signal, opts.signal]) : timer.signal;

    let res: TransportResponse;
    try {
      res = await activeTransport({ url: MISTRAL_CHAT_URL, apiKey: resolved.key, body, signal });
    } catch (e) {
      if (signal.aborted) {
        const why = opts.signal?.aborted ? "caller cancelled the request" : `timed out after ${this.timeoutMs}ms`;
        return { verdict: "unavailable", reason: `Mistral call ${why}.` };
      }
      return { verdict: "unavailable", reason: `Mistral call failed: ${(e as Error).message.slice(0, 160)}` };
    } finally {
      clearTimeout(timeoutId);
    }

    // 5. Status -> verdict.
    if (res.status < 200 || res.status >= 300) {
      return classifyStatus(res, this.model);
    }

    // 6. Parse the success body.
    const j = res.json as {
      model?: unknown;
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    } | null;
    if (!j || typeof j !== "object") {
      return { verdict: "unavailable", reason: `Mistral returned a non-JSON body (HTTP ${res.status}).` };
    }
    const first = Array.isArray(j.choices) ? j.choices[0] : undefined;
    if (!first) {
      return { verdict: "unavailable", reason: "Mistral returned no choices." };
    }
    const text = extractText(first.message?.content);
    if (text === "") {
      return { verdict: "unavailable", reason: "Mistral returned an empty response." };
    }

    const u = j.usage ?? {};
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const tokensUsed = typeof u.total_tokens === "number" ? u.total_tokens : (num(u.prompt_tokens) + num(u.completion_tokens));
    const modelUsed = typeof j.model === "string" && j.model !== "" ? j.model : this.model;

    const result: CallResult = { text, tokensUsed, modelUsed };
    if (opts.responseSchema) {
      try {
        result.json = JSON.parse(text);
      } catch {
        return { verdict: "unavailable", reason: "Mistral returned non-JSON despite responseSchema (malformed response)." };
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// CLI entry. `bun MistralClient.ts --prompt "..." [--model ...] [--thinking ...] ...`
// ---------------------------------------------------------------------------
if (import.meta.main) await MistralClient.runAsCli(process.argv, "bun MistralClient.ts");
