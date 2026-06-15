#!/usr/bin/env bun
/**
 * ProviderCli.ts -- the shared one-off CLI runner for any ProviderClient.
 *
 * Flag PARSING + unknown-flag rejection happen in the ProviderClient CONSTRUCTOR (via
 * node:util parseArgs, strict), which decomposes argv into typed fields (client.common +
 * the subclass's own fields). This runner does NOT re-parse argv -- it READS those fields,
 * does the deferred file I/O (subject/system/responseSchema files are read here, at run
 * time, not at construction), assembles the CallOpts, makes the call, and writes the trail.
 *
 * OUTPUT (single line of JSON to STDOUT, exit 0; diagnostics to STDERR):
 *   call success:          CallResult     {"text","json?","tokensUsed","modelUsed","notes?"}
 *   call non-success:      ErrorVerdict   {"verdict","reason",...}
 *   --list-models:         {"default","available"}
 *   --list-thinking-modes: ThinkingModes  {"kind","default","available",["min","max"]}
 *
 * Exit codes: 0 = handled (verdict carries success/failure); 2 = usage error
 * (no --prompt/--subject, or an unreadable --subject/--responseSchema file at run time).
 * Unknown-flag usage errors are raised earlier, by the constructor (CliUsageError -> exit 2
 * at the runAsCli boundary), and never reach this runner.
 *
 * toolset-version: 0.2.0
 */

import { readFile } from "node:fs/promises";
import type { CallOpts } from "./ProviderClient.ts";
import { ProviderClient } from "./ProviderClient.ts";
import { logProviderCall } from "./ProviderLog.ts";
import { providerCallsDir } from "./config.ts";

// The common flag names = the BASE class's getCliOpts() (base vendorCliOpts() is []).
// Resolved once; used to subtract common flags from a concrete class's combined set so
// help can show only the vendor-specific ones.
const COMMON_FLAG_NAMES = new Set(ProviderClient.getCliOpts().map((o) => o.flag));

/** Print one line of JSON to stdout. The ONLY thing that may touch stdout (besides help). */
function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Render the COMMON help section -- USAGE, common flags, query modes, output shapes, exit
 * codes; all SHARED by every vendor. Needs NO client instance.
 *
 * `invocation` is the command prefix the caller supplies, reflecting HOW the tool was
 * invoked (`bun dispatch.ts gemini` via the dispatcher, `bun GeminiClient.ts` direct,
 * `bun dispatch.ts <vendor>` for the dispatcher's bare no-vendor help). This function owns
 * the USAGE line FORMAT; the caller only supplies the prefix.
 * `withCommonBanner` adds the `=== COMMON ... ===` discriminator -- pass true ONLY when a
 * `=== VENDOR ... ===` section follows (the client's full help); omit for the dispatcher's
 * bare help, where there is no vendor section to discriminate from. ASCII only.
 */
export function renderCommonHelp(invocation: string, withCommonBanner = false): string {
  return [
    "USAGE",
    `  ${invocation} --prompt <text> [options]`,
    `  ${invocation} --subject <path> [options]`,
    `  ${invocation} --list-models | --list-thinking-modes | --help`,
    "",
    ...(withCommonBanner
      ? ["=== COMMON (shared by every vendor) ========================================", ""]
      : []),
    "COMMON PARAMETERS (one of --prompt / --subject is REQUIRED for a call)",
    "  --prompt <text>          The user prompt, literally on the command line.",
    "  --subject <path>         Read the user prompt from a file (read at run time).",
    "                           --prompt wins if both are given.",
    "  --system <text>          Optional system prompt / instruction string.",
    "  --system-file <path>     Read the system prompt from a file (alt to --system).",
    "                           --system wins if both given.",
    "  --thinking <mode>        Reasoning effort (provider-validated; unsupported -> error verdict).",
    "  --responseSchema <path>  JSON Schema file -> structured JSON in the `json` field.",
    "                           Omitted -> free text in `text`.",
    "  --model <name>           Model to use. Omitted -> client default.",
    "  --caller <name>          Tag the trail line with who invoked.",
    "  --no-log                 Do NOT write this call to the provider-calls trail.",
    "",
    "QUERY MODES (no model call; print JSON and exit 0)",
    "  --list-models            Print {\"default\",\"available\"}.",
    "  --list-thinking-modes    Print {\"kind\",\"default\",\"available\",[\"min\",\"max\"]}.",
    "                           Accepts --model <name> to target a specific model.",
    "  --help | -h              Print help and exit 0.",
    "",
    "OUTPUT (a single line of JSON to STDOUT; diagnostics go to STDERR)",
    "  success (CallResult):    {\"text\", \"json\"?, \"tokensUsed\", \"modelUsed\", \"notes\"?}",
    "  non-success (ErrorVerdict): {\"verdict\", \"reason\", \"retry_after_ms\"?, \"anomaly\"?}",
    "",
    "TRAIL",
    `  Each call is appended to ${providerCallsDir()}/<provider>/<model>.jsonl`,
    "  (Location configurable via VENDOR_CLIENTS_HOME; see core/config.ts.) Suppress with --no-log.",
    "",
    "EXIT CODES",
    "  0  handled -- the verdict in the JSON carries success/failure.",
    "  2  usage error (unknown flag, no --prompt/--subject, unreadable --subject/--responseSchema file).",
  ].join("\n");
}

/**
 * Render FULL help for a concrete client: the common section + a VENDOR-SPECIFIC OPTIONS
 * section (the flags this client's class declares beyond the common set) + the live
 * model/thinking-mode info. Used for `<Vendor>Client.ts --help` and `dispatch <vendor> --help`.
 */
export function renderHelp(client: ProviderClient, invocation: string): string {
  const models = client.models();
  const tm = client.thinkingModes();
  // The combined set minus the common set = this vendor's own flags.
  const klass = client.constructor as typeof ProviderClient;
  const vendorOpts = klass.getCliOpts().filter((o) => !COMMON_FLAG_NAMES.has(o.flag));

  const thinkingLine =
    tm.kind === "none"
      ? "(none -- this model has no thinking control)"
      : tm.kind === "budget"
        ? `integer budget [${tm.min ?? "?"}..${tm.max ?? "?"}], default ${tm.default}`
        : `${tm.available.join(" | ")} (default: ${tm.default})`;

  // USAGE reflects HOW this client was actually invoked -- the caller passes the exact
  // command prefix (`bun dispatch.ts gemini` via the dispatcher, `bun GeminiClient.ts` direct),
  // so the help shows the one true invocation rather than a confusing two-tier block.
  const lines = [
    renderCommonHelp(invocation, true),
    "",
    `=== VENDOR: ${client.provider} (specific to this vendor) ===`.padEnd(76, "="),
    "",
    `Models -- default: ${models.default}; available: ${models.available.join(", ")}`,
    `Thinking -- ${thinkingLine}`,
  ];
  if (vendorOpts.length > 0) {
    lines.push("", "VENDOR-SPECIFIC OPTIONS (only this vendor accepts these)");
    for (const o of vendorOpts) {
      lines.push(`  ${o.flag}${o.takesValue ? " <value>" : ""}   ${o.description}`);
    }
  } else {
    lines.push("", "(no vendor-specific options -- this vendor uses only the common flags)");
  }
  return lines.join("\n");
}

/**
 * Run a constructed ProviderClient as a one-off CLI. Reads the client's already-parsed
 * fields (client.common); does NOT re-parse argv. `invocation` is the command prefix to
 * show in --help (e.g. `bun dispatch.ts gemini` or `bun GeminiClient.ts`), supplied by the
 * entry point so the help reflects how the tool was actually run. Returns the process exit
 * code (0 for a handled outcome; 2 for a run-time usage error like a missing
 * --prompt/--subject or an unreadable file).
 */
export async function runProviderCli(client: ProviderClient, invocation: string): Promise<number> {
  const c = client.common;

  // --- help (STDOUT, exit 0) ---
  if (c.help) {
    process.stdout.write(renderHelp(client, invocation) + "\n");
    return 0;
  }

  // --- query modes (no call) ---
  if (c.listModels) {
    emit(client.models());
    return 0;
  }
  if (c.listThinkingModes) {
    emit(client.thinkingModes(c.model));
    return 0;
  }

  // --- call mode: assemble the prompt (file I/O happens HERE, at run time) ---
  let userPrompt: string | undefined;
  if (c.promptLiteral !== undefined) {
    userPrompt = c.promptLiteral;
  } else if (c.subjectPath !== undefined) {
    try {
      userPrompt = await readFile(c.subjectPath, "utf8");
    } catch (e) {
      process.stderr.write(`failed to read --subject ${c.subjectPath}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  if (userPrompt === undefined) {
    process.stderr.write(
      "usage: --prompt <text> | --subject <path> [--system <text> | --system-file <path>] " +
        "[--thinking <mode>] [--responseSchema <path>] [--model <name>] [--caller <name>] [--no-log] " +
        "| --list-models | --list-thinking-modes | --help\n",
    );
    return 2;
  }

  const opts: CallOpts = { userPrompt };

  // System prompt: --system literal wins over --system-file (read at run time).
  if (c.systemLiteral !== undefined) {
    opts.systemPrompt = c.systemLiteral;
  } else if (c.systemFilePath !== undefined) {
    try {
      opts.systemPrompt = await readFile(c.systemFilePath, "utf8");
    } catch (e) {
      process.stderr.write(`failed to read --system-file ${c.systemFilePath}: ${(e as Error).message}\n`);
      return 2;
    }
  }

  if (c.thinking !== undefined) opts.thinkingLevel = c.thinking;

  // Response schema: read + parse the file at run time.
  if (c.responseSchemaPath !== undefined) {
    try {
      opts.responseSchema = JSON.parse(await readFile(c.responseSchemaPath, "utf8")) as object;
    } catch (e) {
      process.stderr.write(`failed to read/parse --responseSchema ${c.responseSchemaPath}: ${(e as Error).message}\n`);
      return 2;
    }
  }

  const result = await client.call(opts);

  // Direct-CLI trail (best-effort; never breaks the command). requestedModel = --model or
  // the client's default (the model is fixed at construction).
  if (!c.noLog) {
    await logProviderCall({
      provider: client.provider,
      requestedModel: c.model ?? client.models().default,
      opts,
      result,
      ...(c.caller !== undefined ? { caller: c.caller } : {}),
    });
  }

  emit(result);
  return 0;
}
