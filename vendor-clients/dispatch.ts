#!/usr/bin/env bun
/**
 * dispatch.ts -- one front door to every vendor client.
 *
 * Instead of invoking a vendor's client file directly
 *   (`bun gemini/GeminiClient.ts --prompt "..."`),
 * name the vendor and let the dispatcher route:
 *   (`bun dispatch.ts gemini --prompt "..."`).
 *
 * It resolves the vendor name against the inline VENDORS map, lazy-imports that vendor's
 * CLASS, and hands off to the SAME shared `ProviderClient.runAsCli` the direct-invocation
 * entry blocks use. So the dispatcher adds a routing layer and NOTHING else.
 *
 * It is a near-pure PROXY: it interprets ONLY the vendor token (positionals[0]) and a bare
 * `--help`; it does NO flag validation (that happens in the client constructor, downstream).
 *
 * TWO-PHASE ERROR OWNERSHIP:
 *   phase 1 (here): unknown vendor / no vendor named -> exit 2 (this dispatcher's job).
 *   phase 2 (runAsCli): CliUsageError from bad flags -> exit 2 (shared with the direct path).
 *
 * Adding a vendor: add one line to VENDORS below. The map IS the registry, kept inline.
 *
 * toolset-version: 0.2.0
 */

import { parseArgs } from "node:util";
import type { ProviderClientClass, CliOptSpec } from "./core/ProviderClient.ts";
import { renderCommonHelp } from "./core/ProviderCli.ts";

/**
 * The vendor registry. Each value lazy-imports the vendor's MODULE and returns its CLASS
 * (typed ProviderClientClass -- captures both `new (argv)` and the static getCliOpts()).
 * Lazy so importing the dispatcher does not pull in every vendor SDK; only the chosen
 * vendor's module loads.
 */
export const VENDORS: Record<string, () => Promise<ProviderClientClass>> = {
  gemini: async () => (await import("./gemini/GeminiClient.ts")).GeminiClient,
};

export function knownVendors(): string {
  return Object.keys(VENDORS).sort().join(", ");
}

/**
 * Discovery: every known vendor + its full CLI flag set (common ∪ vendor-specific), as a
 * machine-readable structure. Lazy-imports each vendor's CLASS to read its static
 * getCliOpts() -- no construction, no network, no SDK load (the vendor SDK is lazy INSIDE
 * the client's call(), not at class load). PURE seam (returns data; the caller emits it).
 * Loading every vendor's class module is acceptable here: discovery is not the hot path.
 */
export async function listVendors(): Promise<
  { name: string; cliOpts?: CliOptSpec[]; error?: string }[]
> {
  const names = Object.keys(VENDORS).sort();
  const out: { name: string; cliOpts?: CliOptSpec[]; error?: string }[] = [];
  for (const name of names) {
    // Isolate per-vendor: one vendor whose module fails to import must not sink discovery
    // of the rest. A broken vendor is reported with an `error` field instead of cliOpts.
    try {
      const ClientClass = await VENDORS[name]!();
      out.push({ name, cliOpts: ClientClass.getCliOpts() });
    } catch (e) {
      out.push({ name, error: `failed to load: ${(e as Error).message}` });
    }
  }
  return out;
}

/**
 * Resolve a vendor name to its lazy class-loader, or null if unknown. PURE (no I/O, no
 * exit) -- the testable seam. The thin caller below turns a null into an exit-2 error.
 */
export function resolveVendor(name: string | undefined): (() => Promise<ProviderClientClass>) | null {
  if (name === undefined) return null;
  return VENDORS[name] ?? null;
}

/** Emit one line of JSON to stdout (mirrors runProviderCli's stdout discipline). */
function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Drive the dispatcher over a full process argv ([bun, dispatch.ts, <vendor>, ...flags]).
 *
 * For the paths it OWNS (bare --help, unknown/no vendor) it returns an exit code -- these
 * are returnable + testable. For a successful route it hands off to `ClientClass.runAsCli`,
 * which constructs the client, runs the CLI, and CALLS process.exit -- so that call never
 * returns (the `return 0` after it is unreachable-in-practice, present only for typing).
 */
export async function runDispatch(argv: string[]): Promise<number> {
  // Parse loosely: dispatch needs ONLY positionals (the vendor token) and --help. It must
  // NOT validate flags (strict:false) -- all flag validation happens downstream in the
  // client constructor. `bun -e`-style argv: flags start at index 2.
  // Parse with tokens:true so we get the vendor positional's REAL index (not a string
  // match -- a preceding value-flag whose value equals a vendor name must not be mistaken
  // for the token). `index` is the position within args (argv.slice(2)); +2 maps to argv.
  let vendorName: string | undefined;
  let vendorArgvIdx = -1;
  let help = false;
  let listVendorsRequested = false;
  try {
    // strict:false so dispatch does not reject vendor/flag combos it doesn't know (all
    // flag validation happens downstream in the client constructor). We declare ONLY
    // `help` (with its -h short alias) so both --help and -h land in values.help via the
    // parser -- no hand-rolled argv.includes("-h").
    const parsed = parseArgs({
      args: argv.slice(2),
      options: { help: { type: "boolean", short: "h" }, "list-vendors": { type: "boolean" } },
      strict: false,
      allowPositionals: true,
      tokens: true,
    });
    help = parsed.values.help === true;
    listVendorsRequested = parsed.values["list-vendors"] === true;
    const firstPositional = parsed.tokens.find((t) => t.kind === "positional");
    if (firstPositional && firstPositional.kind === "positional") {
      vendorName = firstPositional.value;
      vendorArgvIdx = firstPositional.index + 2;
    }
  } catch {
    /* parse failure -> no vendor resolved; falls through to the no-vendor error */
  }

  // --list-vendors: machine-readable discovery -- every vendor + its full flag set. JSON,
  // exit 0, no vendor token needed (mirrors a client's --list-models).
  if (listVendorsRequested) {
    emit({ vendors: await listVendors() });
    return 0;
  }

  // Bare --help (no vendor): print the common help (dispatch-form USAGE with the <vendor>
  // placeholder, since none was given; no COMMON banner -- there is no vendor section after
  // it here) + how to get vendor-specific help.
  if (help && vendorName === undefined) {
    process.stdout.write(
      renderCommonHelp("bun dispatch.ts <vendor>") +
        `\n\nVENDOR ROUTING\n  bun dispatch.ts <vendor> [options]\n  bun dispatch.ts --list-vendors        (machine-readable: vendors + their flags, JSON)\n  bun dispatch.ts <vendor> --help       (human-readable, incl. that vendor's specific flags)\n  Known vendors: ${knownVendors()}\n`,
    );
    return 0;
  }

  // Phase 1 -- resolve the vendor (dispatcher's own error domain).
  const loader = resolveVendor(vendorName);
  if (!loader) {
    const msg =
      vendorName === undefined
        ? `no vendor named; usage: bun dispatch.ts <vendor> [flags]; known vendors: ${knownVendors()}`
        : `unknown vendor "${vendorName}"; known vendors: ${knownVendors()}`;
    emit({ verdict: "error", reason: msg });
    process.stderr.write(msg + "\n");
    return 2;
  }

  // Build a client-shaped argv with the vendor token removed (by its REAL index, so a
  // colliding flag value is never mistaken for it), so the downstream client sees exactly
  // what a direct `bun XClient.ts ...` invocation would.
  const clientArgv =
    vendorArgvIdx >= 0 ? [...argv.slice(0, vendorArgvIdx), ...argv.slice(vendorArgvIdx + 1)] : argv;

  // Phase 2 -- hand off to the shared entry. runAsCli constructs the client (its
  // constructor validates flags -> CliUsageError -> exit 2, caught inside runAsCli), runs
  // the CLI, and calls process.exit. This call does NOT return.
  const ClientClass = await loader();
  await ClientClass.runAsCli(clientArgv, `bun dispatch.ts ${vendorName}`);
  return 0; // unreachable in practice (runAsCli exits); satisfies the return type.
}

if (import.meta.main) {
  const code = await runDispatch(process.argv);
  process.exit(code);
}
