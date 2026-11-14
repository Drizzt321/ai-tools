#!/usr/bin/env bun
/**
 * GeminiClient.test.ts -- unit tests for the Gemini model map: every curated model names
 * its lineage (who trained the weights) and host (whose infrastructure receives the
 * prompt), the limits-map loader rejects a model missing either, and both surface through
 * models(), --list-models and --help.
 *
 * NO NETWORK: only query surfaces are exercised. The environment is isolated:
 * VENDOR_CLIENTS_HOME points at an empty temp dir so no developer .env leaks in.
 *
 * Run: bun test (from vendor-clients/)
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../core/ProviderClient.ts";
import { GeminiClient } from "./GeminiClient.ts";
import { validateLimitsMap } from "./GeminiBudget.ts";

const VENDOR_DIR = join(import.meta.dirname, "..");

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "gemini-test-"));
  for (const k of ["VENDOR_CLIENTS_HOME", "VENDOR_CLIENTS_ENV_FILE", "GEMINI_API_KEY"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.VENDOR_CLIENTS_HOME = tmpHome;
  delete process.env.VENDOR_CLIENTS_ENV_FILE;
  delete process.env.GEMINI_API_KEY;
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

function client(...rest: string[]): GeminiClient {
  return new GeminiClient(["bun", "GeminiClient.ts", "--prompt", "x", ...rest]);
}

// ---------------------------------------------------------------------------
describe("models(): lineage and host", () => {
  test("every available id is Google weights hosted by Google", () => {
    const m = client().models();
    expect(m.available.length).toBeGreaterThan(0);
    expect(Object.keys(m.models).sort()).toEqual([...m.available].sort());
    for (const id of m.available) {
      expect(m.models[id]).toEqual({ lineage: "google", host: "google" });
    }
  });
});

describe("limits-map validation (validateLimitsMap)", () => {
  function mapWith(model: Record<string, unknown>): Record<string, unknown> {
    return { tier: "free", models: { g: { lineage: "google", host: "google", rpd: 20, ...model } } };
  }

  test("a well-formed map passes", () => {
    expect(Object.keys(validateLimitsMap(mapWith({}), "fixture"))).toEqual(["g"]);
  });

  for (const field of ["lineage", "host"]) {
    test(`a model missing "${field}" throws CliUsageError, naming the model and the field`, () => {
      const m = mapWith({});
      delete (m.models as Record<string, Record<string, unknown>>).g![field];
      expect(() => validateLimitsMap(m, "fixture")).toThrow(CliUsageError);
      expect(() => validateLimitsMap(m, "fixture")).toThrow(new RegExp(`"g".*"${field}"`));
    });

    test(`an empty "${field}" throws`, () => {
      expect(() => validateLimitsMap(mapWith({ [field]: "" }), "fixture")).toThrow(field);
    });

    test(`a non-string "${field}" throws`, () => {
      expect(() => validateLimitsMap(mapWith({ [field]: 7 }), "fixture")).toThrow(field);
    });
  }

  test("a missing top-level models object still throws (existing rule kept)", () => {
    expect(() => validateLimitsMap({ tier: "free" }, "fixture")).toThrow("models");
  });
});

describe("CLI query modes via dispatch (subprocess, no key in env)", () => {
  function run(...args: string[]): { code: number; stdout: string } {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: tmpHome, VENDOR_CLIENTS_HOME: tmpHome };
    const p = Bun.spawnSync(["bun", "dispatch.ts", "gemini", ...args], { cwd: VENDOR_DIR, env });
    return { code: p.exitCode ?? -1, stdout: p.stdout.toString() };
  }

  test("--list-models -> per-model lineage and host, default and available unchanged", () => {
    const r = run("--list-models");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      default: string;
      available: string[];
      models: Record<string, { lineage: string; host: string }>;
    };
    expect(out.default).toBe("gemini-3.5-flash");
    expect(out.available).toContain("gemini-3.5-flash");
    expect(out.models["gemini-3.5-flash"]).toEqual({ lineage: "google", host: "google" });
  });

  test("--help -> each model shows its lineage and host", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/gemini-3\.5-flash\s+google weights, hosted by google \(default\)/);
  });
});
