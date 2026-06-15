#!/usr/bin/env bun
/**
 * dispatch.test.ts -- tests for the dispatcher + the shared CLI machinery, via the PURE
 * SEAMS (no network, no process.exit).
 *
 * `process.exit` lives only in thin wrappers (runAsCli; the dispatch exit-on-error path),
 * which are NOT unit-tested directly (they would kill the runner). Instead we test:
 *   - resolveVendor (pure name -> loader|null)
 *   - renderCommonHelp content
 *   - the dispatch branches that RETURN a code (bare --help, unknown vendor, no vendor)
 *   - construction/flag validation (new Client(badArgv) throws CliUsageError)
 *   - getCliOpts combination (common vs common+vendor)
 *   - the vendor-token splice (a stub vendor whose constructor records the argv it got)
 *
 * Run: bun test
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runDispatch, resolveVendor, VENDORS, knownVendors } from "./dispatch.ts";
import { renderCommonHelp } from "./core/ProviderCli.ts";
import {
  ProviderClient,
  CliUsageError,
  type CallOpts,
  type CallResult,
  type ErrorVerdict,
  type ThinkingModes,
  type CliOptSpec,
} from "./core/ProviderClient.ts";
import { GeminiClient } from "./gemini/GeminiClient.ts";

// --- stdout/stderr capture (the dispatch branches we test write JSON/usage) ---
let captured: string[];
let originalWrite: typeof process.stdout.write;
let originalErrWrite: typeof process.stderr.write;

beforeEach(() => {
  captured = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  originalErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});
afterEach(() => {
  process.stdout.write = originalWrite;
  process.stderr.write = originalErrWrite;
});

function out(): string {
  return captured.join("");
}
function argv(...rest: string[]): string[] {
  return ["bun", "dispatch.ts", ...rest];
}

// ---------------------------------------------------------------------------
describe("resolveVendor (pure)", () => {
  test("known vendor -> a loader function", () => {
    expect(typeof resolveVendor("gemini")).toBe("function");
  });
  test("unknown vendor -> null", () => {
    expect(resolveVendor("nope")).toBeNull();
  });
  test("undefined -> null", () => {
    expect(resolveVendor(undefined)).toBeNull();
  });
  test("knownVendors lists gemini", () => {
    expect(knownVendors()).toContain("gemini");
  });
});

describe("dispatch error/help branches (returnable, no exit)", () => {
  test("unknown vendor -> exit 2 + error verdict on stdout naming known vendors", async () => {
    const code = await runDispatch(argv("nope", "--list-models"));
    expect(code).toBe(2);
    const j = JSON.parse(out().trim()) as { verdict: string; reason: string };
    expect(j.verdict).toBe("error");
    expect(j.reason).toContain("unknown vendor");
    expect(j.reason).toContain("gemini");
  });

  test("no vendor named -> exit 2 + usage error verdict", async () => {
    const code = await runDispatch(argv("--list-models")); // a flag, no vendor token
    expect(code).toBe(2);
    const j = JSON.parse(out().trim()) as { verdict: string; reason: string };
    expect(j.verdict).toBe("error");
    expect(j.reason).toContain("no vendor named");
  });

  test("--list-vendors -> exit 0 + JSON of vendors with their flag sets", async () => {
    const code = await runDispatch(argv("--list-vendors"));
    expect(code).toBe(0);
    const j = JSON.parse(out().trim()) as { vendors: { name: string; cliOpts: { flag: string }[] }[] };
    const gemini = j.vendors.find((v) => v.name === "gemini");
    expect(gemini).toBeDefined();
    const flags = gemini!.cliOpts.map((o) => o.flag);
    expect(flags).toContain("--prompt");   // common
    expect(flags).toContain("--timeout");  // gemini vendor-specific
  });

  test("bare --help (no vendor) -> exit 0 + common help + vendor-routing pointer", async () => {
    const code = await runDispatch(argv("--help"));
    expect(code).toBe(0);
    const s = out();
    expect(s).toContain("COMMON PARAMETERS");          // from renderCommonHelp
    expect(s).toContain("bun dispatch.ts <vendor> --help"); // the pointer
    expect(s).toContain("gemini");                      // known-vendors line
  });
});

describe("renderCommonHelp (pure)", () => {
  test("contains the common flags and exit-code section; no COMMON banner without one requested", () => {
    const s = renderCommonHelp("bun dispatch.ts <vendor>");
    expect(s).toContain("USAGE");
    expect(s).toContain("bun dispatch.ts <vendor> --prompt"); // invocation prefix is used
    expect(s).toContain("--responseSchema");
    expect(s).toContain("EXIT CODES");
    expect(s).not.toContain("=== COMMON"); // banner only when withCommonBanner=true
  });
  test("includes the COMMON discriminator banner when requested", () => {
    const s = renderCommonHelp("bun foo", true);
    expect(s).toContain("=== COMMON (shared by every vendor)");
  });
});

describe("getCliOpts combination", () => {
  test("base getCliOpts = common only (no --timeout)", () => {
    const flags = ProviderClient.getCliOpts().map((o) => o.flag);
    expect(flags).toContain("--prompt");
    expect(flags).not.toContain("--timeout");
  });
  test("GeminiClient.getCliOpts = common + vendor (--timeout present)", () => {
    const flags = GeminiClient.getCliOpts().map((o) => o.flag);
    expect(flags).toContain("--prompt");      // inherited common
    expect(flags).toContain("--timeout");     // vendor-specific
  });
});

describe("construction / flag validation (throws CliUsageError, no exit)", () => {
  test("unknown flag throws CliUsageError", () => {
    expect(() => new GeminiClient(argv("--bogusflag"))).toThrow(CliUsageError);
  });
  test("bad --timeout (non-numeric) throws CliUsageError", () => {
    expect(() => new GeminiClient(argv("--prompt", "x", "--timeout", "abc"))).toThrow(CliUsageError);
  });
  test("unknown --model throws CliUsageError", () => {
    expect(() => new GeminiClient(argv("--prompt", "x", "--model", "not-a-real-model"))).toThrow(CliUsageError);
  });
  test("valid common flags construct without throwing", () => {
    expect(() => new GeminiClient(argv("--prompt", "x", "--timeout", "5000"))).not.toThrow();
  });
  test("-h short alias is accepted (not rejected as unknown) and sets help", () => {
    // Regression: parseArgs(strict) threw on -h before the short alias was registered.
    let c: GeminiClient | undefined;
    expect(() => { c = new GeminiClient(argv("-h")); }).not.toThrow();
    expect(c!.common.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Vendor-token splice -- a stub vendor CLASS whose constructor records the argv it got.
// Registered into VENDORS for the duration; routed via runDispatch. NOTE: runDispatch's
// route path calls ClientClass.runAsCli which would process.exit -- so to test the SPLICE
// (what argv the client receives) we register a stub whose runAsCli is overridden to
// capture argv and NOT exit.
// ---------------------------------------------------------------------------
describe("vendor-token splice (stub vendor)", () => {
  let seenArgv: string[] | null;
  let seenInvocation: string | null;

  class StubClient extends ProviderClient {
    readonly provider = "stub";
    protected static override vendorCliOpts(): CliOptSpec[] {
      return [];
    }
    // Override the entry helper so the test can observe argv + invocation WITHOUT process.exit.
    static override async runAsCli(a: string[], inv: string): Promise<never> {
      seenArgv = a;
      seenInvocation = inv;
      return undefined as never; // test-only: do not exit
    }
    call(_o: CallOpts): Promise<CallResult | ErrorVerdict> {
      return Promise.resolve({ text: "", tokensUsed: 0, modelUsed: "stub" });
    }
    maxBundleTokens(): number {
      return 1000;
    }
    isConfigured(): Promise<{ configured: boolean; reason: string }> {
      return Promise.resolve({ configured: true, reason: "stub" });
    }
    depsReady(): ErrorVerdict | null {
      return null;
    }
    models(): { default: string; available: string[] } {
      return { default: "stub-model", available: ["stub-model"] };
    }
    thinkingModes(): ThinkingModes {
      return { kind: "none", default: "", available: [] };
    }
  }

  beforeEach(() => {
    seenArgv = null;
    seenInvocation = null;
    VENDORS.stub = async () => StubClient;
  });
  afterEach(() => {
    delete VENDORS.stub;
  });

  test("strips the vendor token from the argv handed to the client", async () => {
    await runDispatch(argv("stub", "--list-models"));
    expect(seenArgv).not.toBeNull();
    expect(seenArgv).not.toContain("stub");
    expect(seenArgv![0]).toBe("bun");
    expect(seenArgv![1]).toBe("dispatch.ts");
    expect(seenArgv).toContain("--list-models");
  });

  test("passes the dispatch-form invocation (with the resolved vendor) to runAsCli", async () => {
    await runDispatch(argv("stub", "--list-models"));
    expect(seenInvocation).toBe("bun dispatch.ts stub");
  });

  test("preserves a boolean flag that preceded the vendor token", async () => {
    await runDispatch(argv("--no-log", "stub", "--list-models"));
    expect(seenArgv).toEqual(["bun", "dispatch.ts", "--no-log", "--list-models"]);
  });

  test("a preceding value-flag whose VALUE equals the vendor name does not corrupt the splice", async () => {
    // Regression: indexOf(vendorName) would have spliced the --caller VALUE "stub" instead
    // of the real vendor positional. The positional-index splice must remove only the token.
    await runDispatch(argv("--caller", "stub", "stub", "--list-models"));
    expect(seenArgv).toEqual(["bun", "dispatch.ts", "--caller", "stub", "--list-models"]);
  });
});
