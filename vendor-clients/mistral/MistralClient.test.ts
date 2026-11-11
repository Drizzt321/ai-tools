#!/usr/bin/env bun
/**
 * MistralClient.test.ts -- unit tests for the Mistral vendor client, written from the
 * test spec (personal-os plans/mistral-vendor-client.md section 7) before the client.
 *
 * NO NETWORK: every call goes through an injected fake transport (setMistralTransport);
 * fetchTransport itself is tested against a mocked globalThis.fetch. The environment is
 * isolated: VENDOR_CLIENTS_HOME points at an empty temp dir so no developer .env leaks
 * in, and MISTRAL_API_KEY is a fake value set per test.
 *
 * Run: bun test (from vendor-clients/)
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError, isErrorVerdict, type CallResult, type ErrorVerdict } from "../core/ProviderClient.ts";
import { MistralClient, MISTRAL_CHAT_URL, setMistralTransport } from "./MistralClient.ts";
import { fetchTransport, type MistralTransport, type TransportRequest, type TransportResponse } from "./MistralTransport.ts";

const FAKE_KEY = "test-key-DO-NOT-LEAK-7f3a9c";
const VENDOR_DIR = join(import.meta.dirname, "..");

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "mistral-test-"));
  for (const k of ["VENDOR_CLIENTS_HOME", "VENDOR_CLIENTS_ENV_FILE", "MISTRAL_API_KEY"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.VENDOR_CLIENTS_HOME = tmpHome;
  delete process.env.VENDOR_CLIENTS_ENV_FILE;
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

// --- fake transport -----------------------------------------------------------

let calls: TransportRequest[];

beforeEach(() => {
  calls = [];
  process.env.MISTRAL_API_KEY = FAKE_KEY;
});

afterEach(() => {
  setMistralTransport(null);
});

/** A transport that records each request and answers with the given response. */
function respondWith(res: TransportResponse): MistralTransport {
  return async (req) => {
    calls.push(req);
    return res;
  };
}

/** A transport that fails the test if it is ever called. */
const forbiddenTransport: MistralTransport = async (req) => {
  calls.push(req);
  throw new Error("transport must not be called");
};

/** A transport that never answers until its signal aborts. */
const hangingTransport: MistralTransport = (req) => {
  calls.push(req);
  return new Promise((_resolve, reject) => {
    req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
};

function ok(content: unknown, extra: Record<string, unknown> = {}): TransportResponse {
  const json = {
    id: "cmpl-test",
    object: "chat.completion",
    created: 0,
    model: "mistral-large-4",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  };
  return { status: 200, headers: {}, json, rawText: JSON.stringify(json) };
}

function httpError(status: number, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): TransportResponse {
  const json = { object: "error", message: `status ${status}`, type: "test_error", param: null, code: null, ...body };
  return { status, headers, json, rawText: JSON.stringify(json) };
}

function argv(...rest: string[]): string[] {
  return ["bun", "MistralClient.ts", ...rest];
}

function client(...rest: string[]): MistralClient {
  return new MistralClient(argv("--prompt", "x", ...rest));
}

function body(i = 0): Record<string, unknown> {
  const req = calls[i];
  if (!req) {
    throw new Error(`no transport call #${i}`);
  }
  return req.body as Record<string, unknown>;
}

function expectVerdict(r: CallResult | ErrorVerdict, verdict: ErrorVerdict["verdict"]): ErrorVerdict {
  expect(isErrorVerdict(r)).toBe(true);
  const v = r as ErrorVerdict;
  expect(v.verdict).toBe(verdict);
  return v;
}

function expectSuccess(r: CallResult | ErrorVerdict): CallResult {
  if (isErrorVerdict(r)) {
    throw new Error(`expected success, got ${JSON.stringify(r)}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
describe("query surface (no network, no key)", () => {
  test("models(): default is mistral-large-4 and all four catalog ids are available", () => {
    const m = client().models();
    expect(m.default).toBe("mistral-large-4");
    expect(m.available).toEqual(
      expect.arrayContaining(["mistral-large-4", "zai-glm-5-3", "zai-glm-5-3-flash", "deepseek-v4-1-flash-1017"]),
    );
  });

  test("thinkingModes() for the default model: level, default high, low|medium|high", () => {
    expect(client().thinkingModes()).toEqual({ kind: "level", default: "high", available: ["low", "medium", "high"] });
  });

  test("thinkingModes(zai-glm-5-3-flash): default low, low|high|max", () => {
    expect(client().thinkingModes("zai-glm-5-3-flash")).toEqual({ kind: "level", default: "low", available: ["low", "high", "max"] });
  });

  test("thinkingModes(deepseek): level, default low, none|low|high|xhigh|max (live-probed 2026-11-11)", () => {
    expect(client().thinkingModes("deepseek-v4-1-flash-1017")).toEqual({
      kind: "level",
      default: "low",
      available: ["none", "low", "high", "xhigh", "max"],
    });
  });

  test("thinkingModes(unknown model): kind none rather than a throw", () => {
    expect(client().thinkingModes("not-a-model").kind).toBe("none");
  });

  test("thinkingModes() follows --model", () => {
    expect(client("--model", "zai-glm-5-3").thinkingModes().default).toBe("high");
  });

  test("maxBundleTokens comes from the catalog", () => {
    expect(client().maxBundleTokens("mistral-large-4")).toBe(900_000);
  });

  test("depsReady(): null (no runtime deps)", () => {
    expect(client().depsReady()).toBeNull();
  });

  test("query methods never touch the transport", () => {
    setMistralTransport(forbiddenTransport);
    const c = client();
    c.models();
    c.thinkingModes();
    c.maxBundleTokens("zai-glm-5-3");
    c.depsReady();
    expect(calls.length).toBe(0);
  });
});

describe("CLI query modes via dispatch (subprocess, no key in env)", () => {
  function run(...args: string[]): { code: number; stdout: string } {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: tmpHome, VENDOR_CLIENTS_HOME: tmpHome };
    const p = Bun.spawnSync(["bun", "dispatch.ts", "mistral", ...args], { cwd: VENDOR_DIR, env });
    return { code: p.exitCode ?? -1, stdout: p.stdout.toString() };
  }

  test("--list-models -> exit 0 + JSON with the default", () => {
    const r = run("--list-models");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { default: string }).default).toBe("mistral-large-4");
  });

  test("--list-thinking-modes --model zai-glm-5-3 -> exit 0 + that model's modes", () => {
    const r = run("--list-thinking-modes", "--model", "zai-glm-5-3");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { available: string[] }).available).toEqual(["low", "high", "max"]);
  });

  test("--help -> exit 0 and lists the vendor-specific --timeout flag", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--timeout");
  });

  test("a call with no key -> exit 0 + setup-required naming MISTRAL_API_KEY", () => {
    const r = run("--prompt", "x", "--no-log");
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout) as ErrorVerdict;
    expect(v.verdict).toBe("setup-required");
    expect(v.reason).toContain("MISTRAL_API_KEY");
  });
});

// ---------------------------------------------------------------------------
describe("flag validation (construction)", () => {
  test("unknown --model -> CliUsageError", () => {
    expect(() => client("--model", "not-a-model")).toThrow(CliUsageError);
  });

  for (const bad of ["0", "-5", "abc"]) {
    test(`--timeout ${bad} -> CliUsageError`, () => {
      expect(() => client("--timeout", bad)).toThrow(CliUsageError);
    });
  }

  test("valid --model and --timeout construct", () => {
    expect(() => client("--model", "zai-glm-5-3", "--timeout", "5000")).not.toThrow();
  });

  test("unknown flag -> CliUsageError", () => {
    expect(() => client("--bogus")).toThrow(CliUsageError);
  });

  test("-h is accepted and sets help", () => {
    expect(new MistralClient(argv("-h")).common.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("failures that must happen before any network call", () => {
  test("missing key -> setup-required naming MISTRAL_API_KEY; transport not called", async () => {
    delete process.env.MISTRAL_API_KEY;
    setMistralTransport(forbiddenTransport);
    const v = expectVerdict(await client().call({ userPrompt: "x" }), "setup-required");
    expect(v.reason).toContain("MISTRAL_API_KEY");
    expect(calls.length).toBe(0);
  });

  test("isConfigured(): false without a key, true with one; reason never contains the key", async () => {
    delete process.env.MISTRAL_API_KEY;
    expect((await client().isConfigured()).configured).toBe(false);
    process.env.MISTRAL_API_KEY = FAKE_KEY;
    const yes = await client().isConfigured();
    expect(yes.configured).toBe(true);
    expect(yes.reason).not.toContain(FAKE_KEY);
  });

  test("unsupported --thinking for the model (max on large-4) -> error; transport not called", async () => {
    setMistralTransport(forbiddenTransport);
    const v = expectVerdict(await client().call({ userPrompt: "x", thinkingLevel: "max" }), "error");
    expect(v.reason).toContain("max");
    expect(calls.length).toBe(0);
  });

  test("--thinking none on large-4 (documented as not accepted) -> error", async () => {
    setMistralTransport(forbiddenTransport);
    expectVerdict(await client().call({ userPrompt: "x", thinkingLevel: "none" }), "error");
    expect(calls.length).toBe(0);
  });

  test("--thinking medium on deepseek (not among its levels) -> error; transport not called", async () => {
    setMistralTransport(forbiddenTransport);
    const c = client("--model", "deepseek-v4-1-flash-1017");
    expectVerdict(await c.call({ userPrompt: "x", thinkingLevel: "medium" }), "error");
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("request shape", () => {
  test("posts to the chat completions URL with the resolved key", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client().call({ userPrompt: "x" });
    expect(calls[0]?.url).toBe(MISTRAL_CHAT_URL);
    expect(MISTRAL_CHAT_URL).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(calls[0]?.apiKey).toBe(FAKE_KEY);
  });

  test("system prompt -> a separate system message before the user message", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client().call({ userPrompt: "the question", systemPrompt: "be brief" });
    expect(body().messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "the question" },
    ]);
  });

  test("no system prompt -> user message only", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client().call({ userPrompt: "the question" });
    expect(body().messages).toEqual([{ role: "user", content: "the question" }]);
  });

  test("model field is the resolved model (default and --model)", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client().call({ userPrompt: "x" });
    await client("--model", "zai-glm-5-3").call({ userPrompt: "x" });
    expect(body(0).model).toBe("mistral-large-4");
    expect(body(1).model).toBe("zai-glm-5-3");
  });

  test("reasoning_effort defaults to the catalog default (large-4 -> high, glm flash -> low)", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client().call({ userPrompt: "x" });
    await client("--model", "zai-glm-5-3-flash").call({ userPrompt: "x" });
    expect(body(0).reasoning_effort).toBe("high");
    expect(body(1).reasoning_effort).toBe("low");
  });

  test("an explicit --thinking overrides the default per call", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client().call({ userPrompt: "x", thinkingLevel: "low" });
    expect(body().reasoning_effort).toBe("low");
  });

  test("deepseek: default reasoning_effort low; --thinking none is sent as 'none'", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client("--model", "deepseek-v4-1-flash-1017").call({ userPrompt: "x" });
    await client("--model", "deepseek-v4-1-flash-1017").call({ userPrompt: "x", thinkingLevel: "none" });
    expect(body(0).reasoning_effort).toBe("low");
    expect(body(1).reasoning_effort).toBe("none");
  });

  test("no schema -> no response_format; never stream", async () => {
    setMistralTransport(respondWith(ok("hi")));
    await client().call({ userPrompt: "x" });
    expect("response_format" in body()).toBe(false);
    expect(body().stream).toBeUndefined();
  });

  test("schema -> response_format json_schema, strict, schema passed through, name from sanitized title", async () => {
    const schema = { title: "Review Result!", type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    setMistralTransport(respondWith(ok('{"ok":true}')));
    await client().call({ userPrompt: "x", responseSchema: schema });
    expect(body().response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Review_Result_", schema, strict: true },
    });
  });

  test("schema without a title -> json_schema name 'response'", async () => {
    setMistralTransport(respondWith(ok('{"ok":true}')));
    await client().call({ userPrompt: "x", responseSchema: { type: "object" } });
    const rf = body().response_format as { json_schema: { name: string } };
    expect(rf.json_schema.name).toBe("response");
  });
});

// ---------------------------------------------------------------------------
describe("response parsing", () => {
  test("string content -> text, tokens, modelUsed", async () => {
    setMistralTransport(respondWith(ok("the answer", { model: "mistral-large-4-2610" })));
    const r = expectSuccess(await client().call({ userPrompt: "x" }));
    expect(r.text).toBe("the answer");
    expect(r.tokensUsed).toBe(15);
    expect(r.modelUsed).toBe("mistral-large-4-2610");
  });

  test("chunk list -> text chunks only; thinking dropped", async () => {
    const content = [
      { type: "thinking", thinking: [{ type: "text", text: "secret reasoning" }] },
      { type: "text", text: "final answer" },
    ];
    setMistralTransport(respondWith(ok(content)));
    const r = expectSuccess(await client().call({ userPrompt: "x" }));
    expect(r.text).toBe("final answer");
    expect(r.text).not.toContain("secret reasoning");
  });

  test("multiple text chunks are concatenated in order", async () => {
    setMistralTransport(respondWith(ok([{ type: "text", text: "part one, " }, { type: "text", text: "part two" }])));
    expect(expectSuccess(await client().call({ userPrompt: "x" })).text).toBe("part one, part two");
  });

  test("usage without total_tokens -> prompt + completion", async () => {
    setMistralTransport(respondWith(ok("hi", { usage: { prompt_tokens: 7, completion_tokens: 4 } })));
    expect(expectSuccess(await client().call({ userPrompt: "x" })).tokensUsed).toBe(11);
  });

  test("response without a model field -> modelUsed is the requested model", async () => {
    const res = ok("hi");
    delete (res.json as Record<string, unknown>).model;
    setMistralTransport(respondWith(res));
    expect(expectSuccess(await client("--model", "zai-glm-5-3").call({ userPrompt: "x" })).modelUsed).toBe("zai-glm-5-3");
  });

  test("empty content -> unavailable", async () => {
    setMistralTransport(respondWith(ok("")));
    expectVerdict(await client().call({ userPrompt: "x" }), "unavailable");
  });

  test("no choices -> unavailable", async () => {
    setMistralTransport(respondWith(ok("hi", { choices: [] })));
    expectVerdict(await client().call({ userPrompt: "x" }), "unavailable");
  });

  test("200 with a non-JSON body -> unavailable", async () => {
    setMistralTransport(respondWith({ status: 200, headers: {}, json: null, rawText: "<html>oops</html>" }));
    expectVerdict(await client().call({ userPrompt: "x" }), "unavailable");
  });
});

describe("structured output", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };

  test("JSON text -> json populated, text kept", async () => {
    setMistralTransport(respondWith(ok('{"ok":true}')));
    const r = expectSuccess(await client().call({ userPrompt: "x", responseSchema: schema }));
    expect(r.json).toEqual({ ok: true });
    expect(r.text).toBe('{"ok":true}');
  });

  test("JSON inside a chunk list (thinking + text) -> json from the text chunk", async () => {
    const content = [
      { type: "thinking", thinking: [{ type: "text", text: "hmm" }] },
      { type: "text", text: '{"ok":false}' },
    ];
    setMistralTransport(respondWith(ok(content)));
    expect(expectSuccess(await client().call({ userPrompt: "x", responseSchema: schema })).json).toEqual({ ok: false });
  });

  test("non-JSON text despite a schema -> unavailable", async () => {
    setMistralTransport(respondWith(ok("sure! here you go")));
    expectVerdict(await client().call({ userPrompt: "x", responseSchema: schema }), "unavailable");
  });

  test("no schema -> no json field", async () => {
    setMistralTransport(respondWith(ok('{"ok":true}')));
    expect(expectSuccess(await client().call({ userPrompt: "x" })).json).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("HTTP status -> verdict", () => {
  async function callWith(res: TransportResponse, ...flags: string[]): Promise<CallResult | ErrorVerdict> {
    setMistralTransport(respondWith(res));
    return client(...flags).call({ userPrompt: "x" });
  }

  test("401 -> setup-required", async () => {
    expectVerdict(await callWith(httpError(401)), "setup-required");
  });

  test("403 -> setup-required, reason names the model", async () => {
    const v = expectVerdict(await callWith(httpError(403), "--model", "zai-glm-5-3"), "setup-required");
    expect(v.reason).toContain("zai-glm-5-3");
  });

  test("404 -> unavailable", async () => {
    expectVerdict(await callWith(httpError(404)), "unavailable");
  });

  test("422 -> error with anomaly, reason carries Mistral's message and param", async () => {
    const v = expectVerdict(
      await callWith(httpError(422, { message: "Invalid schema keyword", param: "response_format" })),
      "error",
    );
    expect(v.anomaly).toBe(true);
    expect(v.reason).toContain("Invalid schema keyword");
    expect(v.reason).toContain("response_format");
  });

  test("422 with a FastAPI-style detail body still yields a useful reason", async () => {
    const res: TransportResponse = {
      status: 422,
      headers: {},
      json: { detail: [{ loc: ["body", "reasoning_effort"], msg: "bad value" }] },
      rawText: "",
    };
    const v = expectVerdict(await callWith(res), "error");
    expect(v.reason).toContain("bad value");
  });

  test("422 with detail nested inside message (Mistral's live shape) -> reason carries the msg", async () => {
    const res: TransportResponse = {
      status: 422,
      headers: {},
      json: {
        object: "error",
        message: { detail: [{ type: "enum", loc: ["body", "reasoning_effort"], msg: "Input should be 'low' or 'high'" }] },
        type: "invalid_request_error",
        param: null,
        code: null,
      },
      rawText: "{\"raw\":\"should not be the reason\"}",
    };
    const v = expectVerdict(await callWith(res), "error");
    expect(v.reason).toContain("body.reasoning_effort: Input should be 'low' or 'high'");
    expect(v.reason).not.toContain("should not be the reason");
  });

  test("400 invalid args (Mistral's live shape: string message, code) -> error with the message", async () => {
    const v = expectVerdict(
      await callWith(httpError(400, { message: "reasoning_effort 'minimal' is not supported for this model", code: "3051" })),
      "error",
    );
    expect(v.anomaly).toBe(true);
    expect(v.reason).toContain("not supported for this model");
  });

  test("429 with Retry-After seconds -> rate-limited, retry_after_ms", async () => {
    const v = expectVerdict(await callWith(httpError(429, {}, { "retry-after": "7" })), "rate-limited");
    expect(v.retry_after_ms).toBe(7000);
  });

  test("429 with Retry-After HTTP-date -> positive retry_after_ms", async () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    const v = expectVerdict(await callWith(httpError(429, {}, { "retry-after": when })), "rate-limited");
    expect(v.retry_after_ms).toBeGreaterThan(0);
    expect(v.retry_after_ms).toBeLessThanOrEqual(6000);
  });

  test("429 without Retry-After -> no retry_after_ms", async () => {
    const v = expectVerdict(await callWith(httpError(429)), "rate-limited");
    expect(v.retry_after_ms).toBeUndefined();
  });

  for (const status of [500, 502, 503, 504]) {
    test(`${status} -> unavailable`, async () => {
      expectVerdict(await callWith(httpError(status)), "unavailable");
    });
  }

  test("no verdict reason ever contains the key", async () => {
    for (const status of [401, 403, 404, 422, 429, 500]) {
      const r = await callWith(httpError(status, { message: "boom" }));
      expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    }
  });
});

describe("abort and transport failure", () => {
  test("internal timeout -> unavailable, reason says timed out", async () => {
    setMistralTransport(hangingTransport);
    const v = expectVerdict(await client("--timeout", "20").call({ userPrompt: "x" }), "unavailable");
    expect(v.reason).toContain("timed out");
  });

  test("caller cancel -> unavailable, reason says cancelled (distinct from timeout)", async () => {
    setMistralTransport(hangingTransport);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 10);
    const v = expectVerdict(await client().call({ userPrompt: "x", signal: ctl.signal }), "unavailable");
    expect(v.reason).toContain("cancelled");
  });

  test("the internal timeout still applies when the caller passes a signal", async () => {
    setMistralTransport(hangingTransport);
    const ctl = new AbortController();
    const v = expectVerdict(await client("--timeout", "20").call({ userPrompt: "x", signal: ctl.signal }), "unavailable");
    expect(v.reason).toContain("timed out");
  });

  test("transport throws -> unavailable with a truncated message", async () => {
    setMistralTransport(async () => {
      throw new Error("ECONNRESET " + "x".repeat(500));
    });
    const v = expectVerdict(await client().call({ userPrompt: "x" }), "unavailable");
    expect(v.reason).toContain("ECONNRESET");
    expect(v.reason.length).toBeLessThan(260);
  });
});

// ---------------------------------------------------------------------------
describe("fetchTransport (mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit } | null;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(status: number, text: string, headers: Record<string, string> = {}): void {
    seen = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(text, { status, headers });
    }) as typeof fetch;
  }

  test("POSTs JSON with Bearer auth, JSON content type and accept, and the signal", async () => {
    mockFetch(200, '{"a":1}');
    const ctl = new AbortController();
    await fetchTransport({ url: MISTRAL_CHAT_URL, apiKey: FAKE_KEY, body: { model: "m" }, signal: ctl.signal });
    expect(seen?.url).toBe(MISTRAL_CHAT_URL);
    expect(seen?.init.method).toBe("POST");
    const h = new Headers(seen?.init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${FAKE_KEY}`);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("accept")).toBe("application/json");
    expect(seen?.init.body).toBe('{"model":"m"}');
    expect(seen?.init.signal).toBe(ctl.signal);
  });

  test("JSON body -> parsed json, status, lower-cased headers", async () => {
    mockFetch(429, '{"message":"slow down"}', { "Retry-After": "3" });
    const r = await fetchTransport({ url: MISTRAL_CHAT_URL, apiKey: FAKE_KEY, body: {}, signal: new AbortController().signal });
    expect(r.status).toBe(429);
    expect(r.json).toEqual({ message: "slow down" });
    expect(r.headers["retry-after"]).toBe("3");
  });

  test("non-JSON body -> json null, rawText kept", async () => {
    mockFetch(502, "<html>bad gateway</html>");
    const r = await fetchTransport({ url: MISTRAL_CHAT_URL, apiKey: FAKE_KEY, body: {}, signal: new AbortController().signal });
    expect(r.json).toBeNull();
    expect(r.rawText).toContain("bad gateway");
  });
});
