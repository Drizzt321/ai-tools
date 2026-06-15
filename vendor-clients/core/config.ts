#!/usr/bin/env bun
/**
 * config.ts -- cross-vendor path resolution + environment hydration.
 *
 * Holds only CROSS-VENDOR concerns. Vendor-SPECIFIC state (e.g. Gemini's per-model
 * RPD budget counter) does NOT live here -- a vendor resolves its own state location
 * (see GeminiBudget.ts and its VENDOR_CLIENTS_GEMINI_STATE override).
 *
 * Paths anchor to the component dir (`vendor-clients/`, one level up from this file)
 * so a fresh clone is self-contained with zero configuration. Set VENDOR_CLIENTS_HOME
 * to relocate everything that derives from home().
 *
 * Functions (not constants) so an env var set by a test or a wrapper at runtime is
 * honored, rather than frozen at module-load time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The component base dir. Default: `vendor-clients/` -- one level up from this file
 * (config.ts lives in vendor-clients/core/), computed via import.meta.dirname so it is
 * independent of the caller and the current working directory. Override with
 * VENDOR_CLIENTS_HOME to relocate the trail (and anything else derived from home()).
 */
export function home(): string {
  return process.env.VENDOR_CLIENTS_HOME ?? join(import.meta.dirname, "..");
}

/**
 * Where the direct-CLI provider call trail (one JSONL per provider/model) is written.
 * Derived from home(); no dedicated override (relocate via VENDOR_CLIENTS_HOME).
 */
export function providerCallsDir(): string {
  return join(home(), "provider-calls");
}

// ---------------------------------------------------------------------------
// Environment hydration (loadEnv)
// ---------------------------------------------------------------------------
//
// PRECEDENCE -- read this before changing the order. The tool reads API keys (and any
// other config) from process.env. loadEnv() populates process.env from .env file(s)
// so that every vendor's key lookup is a uniform `process.env.X` check (no vendor
// reads files itself). Two .env sources are consulted, with a DELIBERATE asymmetry:
//
//   1. vendor-clients/.env  (the default-location file)
//        -- DOTENV CONVENTION: fills GAPS ONLY. A key already present in process.env
//           (i.e. an exported shell variable) WINS over this file. This matches what
//           users expect from any app/library that reads a project .env: your real
//           environment variable is authoritative; the .env is a convenience fallback.
//
//   2. $VENDOR_CLIENTS_ENV_FILE  (an explicitly-pointed-at file, if that env var is set)
//        -- OVERRIDE: this file's values OVERWRITE everything, INCLUDING an exported
//           shell variable. Rationale: explicitly setting VENDOR_CLIENTS_ENV_FILE=/path
//           is a deliberate, current act of intent -- a stronger signal than an ambient
//           shell var -- so it is treated as authoritative. This is the ONE place the
//           tool diverges from the plain dotenv "env always wins" rule, and it is
//           intentional. (If both files define the same key, this one wins -- it is
//           applied last.)
//
// Net precedence, lowest -> highest:
//     vendor-clients/.env  <  exported shell env  <  $VENDOR_CLIENTS_ENV_FILE
//
// Implementation: the default file is applied skip-if-already-set (so shell env wins);
// the explicit override file is applied overwrite (so it beats shell env). process.env
// already holds the shell env as the baseline, so this ordering yields the ladder above.
// ---------------------------------------------------------------------------

/** Parse `KEY=value` lines from .env text. Ignores blanks and `#` comments; strips
 *  one layer of surrounding single/double quotes from the value. Returns a plain map. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Tolerate a leading `export ` (common in shell-sourceable .env files); strip it
    // so `export KEY=val` yields key `KEY`, not `export KEY`.
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no key, or no '=' -> skip
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** Read+parse a .env file; returns {} if it does not exist or cannot be read. */
function readDotenv(path: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {}; // missing/unreadable -> contribute nothing
  }
}

/**
 * The default-location .env file (gap-fill source). Lives at the component root so a
 * clone is self-contained: `vendor-clients/.env`.
 */
export function defaultEnvFile(): string {
  return join(home(), ".env");
}

/**
 * The explicit override .env file path, if VENDOR_CLIENTS_ENV_FILE is set; else null.
 * Values from this file overwrite process.env (including exported shell vars).
 */
export function overrideEnvFile(): string | null {
  return process.env.VENDOR_CLIENTS_ENV_FILE ?? null;
}

/**
 * Hydrate process.env from the .env source(s), applying the documented precedence
 * ladder (vendor-clients/.env  <  exported shell env  <  $VENDOR_CLIENTS_ENV_FILE).
 * Idempotent in effect: re-running re-applies the same rules. Call this ONCE, early,
 * before any vendor reads process.env (see runProviderCli / the CLI entry blocks).
 * Returns the list of keys it set or changed (for diagnostics/tests).
 */
export function loadEnv(): string[] {
  const changed: string[] = [];

  // (1) default file: skip-if-already-set, so an exported shell var wins.
  const fromDefault = readDotenv(defaultEnvFile());
  for (const [k, v] of Object.entries(fromDefault)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      changed.push(k);
    }
  }

  // (2) explicit override file: overwrite, so it beats shell env and the default file.
  const overridePath = overrideEnvFile();
  if (overridePath) {
    const fromOverride = readDotenv(overridePath);
    for (const [k, v] of Object.entries(fromOverride)) {
      if (process.env[k] !== v) {
        process.env[k] = v;
        changed.push(k);
      }
    }
  }

  return changed;
}
