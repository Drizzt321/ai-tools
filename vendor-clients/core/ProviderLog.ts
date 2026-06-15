#!/usr/bin/env bun
/**
 * ProviderLog.ts -- the shared in/out call log for direct provider-CLI invocations.
 *
 * WHY this exists, and WHY it is its own file:
 *   - Consumers that invoke a client via the CLI (the dispatcher, a one-off call)
 *     run through runProviderCli() in ProviderCli.ts. This module is the trail those
 *     calls leave: one JSONL line per call under
 *     <provider-calls-dir>/<provider>/<model>.jsonl (location from config.ts).
 *   - It is SEPARATE from ProviderClient.ts ON PURPOSE: ProviderClient.ts is a pure
 *     types/contract module (zero imports, no side-effects). Logging needs node:fs and
 *     a timestamp, so it lives here -- a companion utility that the shared CLI runner
 *     (ProviderCli.ts) imports. *Client.ts files do NOT import this directly; they get
 *     the trail for free by handing themselves to runProviderCli(). See the CLI
 *     AUTHORING CONTRACT in ProviderClient.ts.
 *
 * new Date() is used here; that is fine -- this code only runs inside a `bun`
 * subprocess (the CLI entry), where a wall-clock timestamp is exactly what we want.
 *
 * toolset-version: 0.1.0
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CallOpts, CallResult, ErrorVerdict } from "./ProviderClient.ts";
import { isErrorVerdict } from "./ProviderClient.ts";
import { providerCallsDir } from "./config.ts";

// Same filename sanitizer the budget counter uses (model names can carry "/" or ":"
// for inference-provider-style endpoints, and version suffixes like "-002").
function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** What runProviderCli() hands us: the parsed input, the outcome, and who called. */
export interface ProviderCallLogEntry {
  /** Stable provider id (client.provider), e.g. "gemini". */
  provider: string;
  /**
   * The model the caller REQUESTED (--model or the client default). Used for the
   * filename when the call FAILED (an ErrorVerdict carries no served model). On
   * success we prefer the response's modelUsed (the model that actually served it).
   */
  requestedModel: string;
  /** The parsed call options (the input side of the trail). */
  opts: CallOpts;
  /** The outcome: a CallResult on success, or an ErrorVerdict. */
  result: CallResult | ErrorVerdict;
  /** Optional --caller value (e.g. "myscript") so a line records who invoked. */
  caller?: string;
}

/**
 * Append one JSONL line recording a direct-CLI provider call. BEST-EFFORT: the call
 * already happened and its result is in the caller's hand, so a logging failure must
 * NEVER break the command -- any error is written to stderr and swallowed.
 *
 * File: <provider-calls-dir>/<provider>/<model>.jsonl
 *   - <model> = result.modelUsed on success (the served model), else requestedModel
 *     (an ErrorVerdict has no served model). Failures thus file alongside successes
 *     for the requested model.
 *
 * The line carries the FULL input and output (no cap): this is a local-only trail on
 * the user's own machine.
 */
export async function logProviderCall(entry: ProviderCallLogEntry): Promise<void> {
  try {
    const errored = isErrorVerdict(entry.result);
    const modelForFile = errored
      ? entry.requestedModel
      : (entry.result as CallResult).modelUsed || entry.requestedModel;

    const dir = join(providerCallsDir(), sanitizeForFilename(entry.provider));
    const file = join(dir, `${sanitizeForFilename(modelForFile)}.jsonl`);

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      provider: entry.provider,
      caller: entry.caller ?? null,
      requested_model: entry.requestedModel,
      model_used: errored ? null : (entry.result as CallResult).modelUsed,
      outcome: errored ? "error" : "success",
      input: {
        system: entry.opts.systemPrompt ?? null,
        prompt: entry.opts.userPrompt,
        thinking: entry.opts.thinkingLevel ?? null,
        has_schema: entry.opts.responseSchema !== undefined,
      },
      output: entry.result,
    });

    await mkdir(dir, { recursive: true });
    await appendFile(file, line + "\n", "utf8");
  } catch (e) {
    // Never let logging break the command. Diagnostic to STDERR only (STDOUT stays
    // parseable JSON for the caller).
    process.stderr.write(
      `[ProviderLog] failed to record call (non-fatal): ${(e as Error).message}\n`,
    );
  }
}
