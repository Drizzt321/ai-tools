#!/usr/bin/env bun
/**
 * ProviderClient.ts -- the generic model-calling contract + shared CLI machinery.
 *
 * A ProviderClient is "a thing that can call a model." It is TASK-AGNOSTIC: it knows
 * nothing about what the call is for (a review, an audit, a one-off question) -- it
 * only knows how to talk to one vendor's API.
 *
 * This is an ABSTRACT BASE CLASS (not a pure interface) because it homes behavior every
 * vendor needs identically: argv parsing (via node:util parseArgs, strict), unknown-flag
 * rejection, common-flag decomposition into typed fields, and the CLI entry helper. A
 * vendor `extends ProviderClient`, overrides the abstract methods + `vendorCliOpts()`, and
 * gets the machinery for free.
 *
 * INVARIANT (deliberate): this module stays a LIGHTWEIGHT, side-effect-free, FILESYSTEM-FREE,
 * SDK-FREE leaf. The constructor parses argv STRINGS into fields (including file PATHS) and
 * validates FORM only -- it does NOT read files (that is deferred to run time, in
 * ProviderCli.runProviderCli, which is async and owns the fs). It must not import config.ts
 * (fs) or any vendor SDK. Type-only consumers should `import type { ProviderClient }`.
 *
 * toolset-version: 0.2.0
 */

import { parseArgs } from "node:util";

/** Input to a single model call. */
export interface CallOpts {
  /** Optional system prompt / instruction. */
  systemPrompt?: string;
  /** The user prompt (the full content to send to the model). */
  userPrompt: string;
  /**
   * Reasoning effort, where the provider supports it. A provider-specific string,
   * NOT a closed union -- providers differ. The PROVIDER validates this against its own
   * thinkingModes(model).available and returns an "error" verdict on an unsupported value.
   * Omit it to let the provider apply its curated default.
   */
  thinkingLevel?: string;
  /**
   * When present, the provider is asked for structured JSON matching this
   * schema, returned in CallResult.json. When absent, free text in CallResult.text.
   */
  responseSchema?: object;
  /** Abort signal for timeout/cancellation. */
  signal?: AbortSignal;
}

/** A successful model call. */
export interface CallResult {
  /** Raw text output (always present; may be the stringified JSON). */
  text: string;
  /** Parsed structured output, present iff responseSchema was supplied. */
  json?: unknown;
  /** Total tokens consumed by the call. */
  tokensUsed: number;
  /** The concrete model that served the call (e.g. "gemini-3.5-flash"). */
  modelUsed: string;
  /** Soft, non-fatal advisories alongside a successful result. */
  notes?: string[];
}

/**
 * A structured non-success outcome:
 *   - "unavailable"    -- transient: API down, network gone, offline
 *   - "setup-required" -- fixable by the user: first-run, missing deps, auth 4xx
 *   - "rate-limited"   -- 429; retry_after_ms when known
 *   - "skipped"        -- not run (e.g. provider binary absent)
 *   - "error"          -- unexpected fault
 */
export interface ErrorVerdict {
  verdict: "unavailable" | "setup-required" | "rate-limited" | "skipped" | "error";
  reason: string;
  retry_after_ms?: number;
  /** Set when this is an anomaly to surface, not a routine state. */
  anomaly?: boolean;
}

/**
 * A provider+model's thinking/reasoning configuration. `kind` captures that the SHAPE
 * differs by model family:
 *   - "level"  -- named string levels (e.g. Gemini-3: minimal|low|medium|high)
 *   - "budget" -- an integer token budget (min/max bound the range)
 *   - "none"   -- the model has no thinking control
 */
export interface ThinkingModes {
  kind: "level" | "budget" | "none";
  default: string;
  available: string[];
  min?: number;
  max?: number;
}

/** Type guard: is this an ErrorVerdict? */
export function isErrorVerdict<T extends object>(r: T | ErrorVerdict): r is ErrorVerdict {
  return "verdict" in r;
}

// ---------------------------------------------------------------------------
// CLI flag taxonomy
// ---------------------------------------------------------------------------

/** A declared CLI flag: its name, whether it takes a value, and a one-line help string. */
export interface CliOptSpec {
  /** Flag name WITH leading `--`, e.g. "--timeout". */
  flag: string;
  /** true: `--flag <value>` (parseArgs type "string"); false: boolean `--flag`. */
  takesValue: boolean;
  /** One-line help description (shown in --help). */
  description: string;
}

/**
 * A usage error in CLI invocation (unknown flag, missing required flag, bad value).
 * Thrown by the constructor (form validation) and by runProviderCli (I/O validation);
 * caught at the entry boundary (runAsCli) and mapped to exit code 2. Distinct from an
 * unexpected Error (a bug), which should surface rather than be masked as exit 2.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * The structural type of a ProviderClient SUBCLASS (constructor) -- captures BOTH the
 * constructible side (`new (argv)`) AND the static side (`getCliOpts()`), which a plain
 * interface cannot. The dispatcher's VENDORS map is typed with this so registration is
 * type-checked.
 */
export type ProviderClientClass = {
  new (argv: string[]): ProviderClient;
  getCliOpts(): CliOptSpec[];
  runAsCli(argv: string[], invocation: string): Promise<never>;
};

/** The flag values the base constructor decomposes argv into (common flags). Paths are
 *  stored, NOT read (file I/O is deferred to run time). */
export interface CommonFlags {
  promptLiteral?: string;     // --prompt
  subjectPath?: string;       // --subject (path; read at run time)
  systemLiteral?: string;     // --system
  systemFilePath?: string;    // --system-file (path; read at run time)
  responseSchemaPath?: string;// --responseSchema (path; read+parsed at run time)
  thinking?: string;          // --thinking
  caller?: string;            // --caller
  noLog: boolean;             // --no-log
  help: boolean;              // --help / -h
  listModels: boolean;        // --list-models
  listThinkingModes: boolean; // --list-thinking-modes
  model?: string;             // --model (common: the runner reads it for the thinking-modes query)
}

export abstract class ProviderClient {
  /**
   * The COMMON flags every provider's CLI accepts. The single source of truth for both
   * help rendering and (via getCliOpts) unknown-flag validation.
   */
  protected static readonly COMMON_OPTS: CliOptSpec[] = [
    { flag: "--prompt", takesValue: true, description: "The user prompt, literally on the command line." },
    { flag: "--subject", takesValue: true, description: "Read the user prompt from a file (alt to --prompt; read at run time)." },
    { flag: "--system", takesValue: true, description: "Optional system prompt / instruction string." },
    { flag: "--system-file", takesValue: true, description: "Read the system prompt from a file (alt to --system)." },
    { flag: "--thinking", takesValue: true, description: "Reasoning effort for the model (provider-validated)." },
    { flag: "--responseSchema", takesValue: true, description: "JSON Schema file -> structured JSON output." },
    { flag: "--model", takesValue: true, description: "Model to use (omitted -> client default)." },
    { flag: "--caller", takesValue: true, description: "Tag the call-trail line with who invoked." },
    { flag: "--no-log", takesValue: false, description: "Do NOT write this call to the provider-calls trail." },
    { flag: "--list-models", takesValue: false, description: "Print the model set as JSON and exit." },
    { flag: "--list-thinking-modes", takesValue: false, description: "Print the thinking modes as JSON and exit." },
    { flag: "--help", takesValue: false, description: "Print help and exit." },
  ];

  /**
   * FINAL -- do NOT override. The full flag set for THIS concrete class: the common set
   * plus whatever the subclass declares in vendorCliOpts(). Called WITHOUT an instance
   * (static) so a dispatcher can render help / validate flags before constructing.
   * `this.vendorCliOpts()` dynamic-dispatches to the subclass override (or the base [] ).
   */
  static getCliOpts(): CliOptSpec[] {
    return [...ProviderClient.COMMON_OPTS, ...this.vendorCliOpts()];
  }

  /** Override THIS (only) to add vendor-specific flags. Default: none. Must be pure
   *  (return a constant list; read no instance state) -- it is callable statically. */
  protected static vendorCliOpts(): CliOptSpec[] {
    return [];
  }

  /** The decomposed common flags, populated by the base constructor. PUBLIC because the
   *  shared runner (runProviderCli, a free function) reads them to assemble the call. */
  readonly common: CommonFlags;

  /** The raw parsed flag values (all flags, common + vendor). The base decomposes the
   *  common ones into `this.common`; a subclass reads ITS OWN flags from here via
   *  vendorFlag(). Kept private; vendorFlag() is the subclass's typed accessor. */
  readonly #rawValues: Record<string, string | boolean | undefined>;

  /**
   * Read a vendor-specific flag's raw value (string for value-flags, true for boolean
   * flags, undefined if absent). For use by a subclass's parseCliOpts() to pull its own
   * declared flags out of the single base parse. Pass the flag name WITHOUT leading `--`.
   */
  protected vendorFlag(name: string): string | boolean | undefined {
    return this.#rawValues[name];
  }

  /**
   * Parse argv against the COMBINED flag spec for this concrete class (strict: unknown
   * flags throw), decompose the common flags into typed fields, and validate FORM. Does
   * NOT read files (deferred to run time) and does NOT touch the network. Synchronous.
   * Throws CliUsageError on a malformed invocation.
   */
  constructor(argv: string[]) {
    const known = (this.constructor as typeof ProviderClient).getCliOpts();
    const options: Record<string, { type: "string" | "boolean"; short?: string }> = {};
    for (const o of known) options[o.flag.replace(/^--/, "")] = { type: o.takesValue ? "string" : "boolean" };
    // `-h` is the documented short alias for --help. Register it so parseArgs(strict)
    // accepts it instead of throwing "unknown option" before we can honor it.
    if (options.help) options.help.short = "h";

    let values: Record<string, string | boolean | undefined>;
    try {
      ({ values } = parseArgs({ args: argv.slice(2), options, allowPositionals: true, strict: true }) as {
        values: Record<string, string | boolean | undefined>;
      });
    } catch (e) {
      // parseArgs(strict) throws on an unknown flag or a value/boolean mismatch.
      throw new CliUsageError((e as Error).message);
    }

    this.#rawValues = values;

    const str = (k: string): string | undefined => (typeof values[k] === "string" ? (values[k] as string) : undefined);
    const bool = (k: string): boolean => values[k] === true; // -h folds into `help` via the short alias above

    this.common = {
      promptLiteral: str("prompt"),
      subjectPath: str("subject"),
      systemLiteral: str("system"),
      systemFilePath: str("system-file"),
      responseSchemaPath: str("responseSchema"),
      thinking: str("thinking"),
      caller: str("caller"),
      noLog: bool("no-log"),
      help: bool("help"),
      listModels: bool("list-models"),
      listThinkingModes: bool("list-thinking-modes"),
      model: str("model"),
    };
  }

  // -------------------------------------------------------------------------
  // CLI entry helper -- the shared `main` body
  // -------------------------------------------------------------------------
  /**
   * Build THIS client from argv (`new this(argv)` -> the concrete subclass), run the CLI,
   * and exit. Catches CliUsageError -> stderr + exit 2; an unexpected error surfaces. This
   * is the process-control BOUNDARY (calls process.exit). The pure-library path is
   * `new XClient(argv)` directly, which never touches this. Both the vendor file's
   * import.meta.main guard AND the dispatcher route through here, so the catch is written once.
   *
   * `invocation` is the command prefix shown in --help, supplied by the caller so the help
   * reflects how the tool was actually run: the entry block passes `bun <Provider>Client.ts`;
   * the dispatcher passes `bun dispatch.ts <resolved-vendor>`.
   */
  static async runAsCli(argv: string[], invocation: string): Promise<never> {
    const { runProviderCli } = await import("./ProviderCli.ts");
    try {
      // `new (this)` builds the subclass runAsCli was called on (verified static this-dispatch).
      const client = new (this as unknown as ProviderClientClass)(argv);
      const code = await runProviderCli(client, invocation);
      process.exit(code);
    } catch (e) {
      if (e instanceof CliUsageError) {
        process.stderr.write(e.message + "\n");
        process.exit(2);
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // The contract every backend implements (abstract).
  // -------------------------------------------------------------------------

  /** Stable provider id, e.g. "gemini". */
  abstract readonly provider: string;

  /** Call the model. Returns a CallResult on success or an ErrorVerdict otherwise. */
  abstract call(opts: CallOpts): Promise<CallResult | ErrorVerdict>;

  /**
   * Discoverable per-model bundle ceiling, in TOKENS. The provider owns its own limit
   * knowledge and returns the effective max it will accept in one call. A consumer asks
   * this to size/cap input without knowing vendor specifics.
   */
  abstract maxBundleTokens(model: string): number;

  /**
   * Is this provider CONFIGURED to run right now -- does it have the credential/binding it
   * needs? A STABLE fact, not a volatile one (NOT rate-limit headroom). Distinct from
   * depsReady(): a provider can be configured (key present) but not bootstrapped (deps absent).
   */
  abstract isConfigured(): Promise<{ configured: boolean; reason: string }>;

  /**
   * Is this provider's local TOOLSET bootstrapped (third-party deps installed)? Returns
   * null when ready, or an ErrorVerdict ("setup-required") when not. A provider needing no
   * local deps returns null. Synchronous (a filesystem-presence check, not a call).
   */
  abstract depsReady(): ErrorVerdict | null;

  /**
   * The provider's curated model set: default + available. Lets a consumer use the default
   * or fan across the set -- discovering models, not hardcoding them.
   */
  abstract models(): { default: string; available: string[] };

  /**
   * The thinking/reasoning modes this provider+model supports. Omit `model` to report the
   * modes for the provider's DEFAULT model. Returns kind:"none" for no thinking control.
   */
  abstract thinkingModes(model?: string): ThinkingModes;
}
