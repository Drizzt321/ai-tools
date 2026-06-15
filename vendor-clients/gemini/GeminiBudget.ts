#!/usr/bin/env bun
/**
 * GeminiBudget.ts -- the RPD budget sidecar for the free-tier Gemini key.
 *
 * Why it exists: the free-tier RPD (requests-per-day) limit is per-PROJECT/per-key,
 * NOT per-machine. So the counter is persisted to a state file and can be SHARED
 * across machines (e.g. a file-sync tool pointing the state dir at a synced folder)
 * to enforce one shared daily budget. RPM/TPM are not tracked (they auto-recover in
 * minutes; only RPD's ~24h exhaustion cliff justifies a persisted counter).
 *
 * Per-MODEL: each model has its own RPD limit (gemini-3.5-flash=20, flash-lite=500,
 * gemma=1500, ...), so each gets its own counter file gemini-budget-<model>.json.
 *
 * Limit resolution (two tiers, most-authoritative first):
 *   1. sidecar.rpd_limit -- REVEALED by a real 429 (ground truth); wins if non-null.
 *   2. gemini-tier-limits.json[model].rpd -- BELIEVED, read from the AI Studio
 *      dashboard (the SDK/API has no quota-query endpoint). Seeds the gate so it
 *      enforces from day one.
 *   3. null -- unknown; allow + warn.
 * A 429 updates the SIDECAR only; the map stays the operator's curated dashboard
 * record (we never silently overwrite the human notes).
 *
 * Concurrency, two layers:
 *   - Same-machine race (a fan-out -> two parallel calls on one box):
 *     proper-lockfile around the read-modify-write + atomic write. IMPLEMENTED.
 *   - Cross-machine race (two boxes bump independently -> file-sync conflict copies):
 *     detect + reconcile is IMPLEMENTED. It runs ONLY inside the lock (withBudgetLock),
 *     after the corrupt-file check -- because reconcile MUTATES (atomic-write + unlink),
 *     and every mutation in this file must be lock-serialized and corrupt-gated. The
 *     lock-free read path (readBudgetChecked) is PURE-READ and never reconciles;
 *     conflicts are resolved at the next write.
 *
 * toolset-version: 0.1.0
 */

import { readFile, writeFile, rename, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { ThinkingModes } from "../core/ProviderClient.ts";
import { CliUsageError } from "../core/ProviderClient.ts";
// proper-lockfile is lazy-imported inside withBudgetLock() (its ONLY user) rather
// than statically here, so this module loads cleanly on a fresh, node_modules-absent
// machine (a file-sync tool may carry the .ts files but not node_modules). A static
// import would crash at module-load time -- before ensureDeps() in GeminiClient can
// fire -- breaking the whole client. Mirrors the @google/genai lazy-import pattern in
// GeminiClient.call().

// The believed-limits map lives next to the code (it is human-editable reference data,
// not runtime state).
const LIMITS_MAP_PATH = join(import.meta.dirname, "gemini-tier-limits.json");

// Where per-model budget counter files live. This is a GEMINI-OWNED concern (the RPD
// budget is a Gemini concept), so the gemini vendor resolves it itself rather than the
// shared core/config.ts. Default: the dir this file lives in (gemini/), so a fresh
// clone is self-contained -- no external state dir required. Override with
// VENDOR_CLIENTS_GEMINI_STATE to point the counters elsewhere (e.g. a synced folder shared
// across machines to enforce one daily quota, or a writable dir outside the repo tree).
// A function (not a const) so an env var set at runtime is honored.
function stateDir(): string {
  return process.env.VENDOR_CLIENTS_GEMINI_STATE ?? import.meta.dirname;
}

// Sanitize a model name into a filesystem-safe counter-file segment (model names can
// contain "/" or ":" for inference-provider-style endpoints).
function sanitizeModel(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function budgetPathFor(model: string): string {
  return join(stateDir(), `gemini-budget-${sanitizeModel(model)}.json`);
}

export interface Budget {
  tier: string;              // "free" in v1
  model: string;             // the model the counter tracks
  rpd_limit: number | null;  // REVEALED limit (from a 429); null = not yet revealed
  rpd_used: number;          // requests today
  rpd_window_start: string;  // "YYYY-MM-DD" of the current RPD window
  last_429: string | null;   // ISO timestamp of the last observed 429
}

// ---------------------------------------------------------------------------
// Believed-limits map (gemini-tier-limits.json). Read once, cached. Returns the
// per-model RPD the operator recorded from the AI Studio dashboard, or null.
// ---------------------------------------------------------------------------
interface ModelLimits {
  rpm?: number | null;
  tpm?: number | null;
  rpd?: number | null;
  input_token_limit?: number | null;  // model context window (from models.get)
  output_token_limit?: number | null;
  // Reasoning control for the generateContent API. `default` is OUR chosen default;
  // `model_default` is Google's own server default (provenance only -- NOT surfaced
  // to consumers). See the _thinking_comment in gemini-tier-limits.json.
  thinking?: {
    kind: "level" | "budget" | "none";
    default: string;
    model_default?: string;
    available: string[];
    min?: number;
    max?: number;
  };
}

// Fallback when a model is absent from the map (or the map is unreadable). Modest
// and safe: better to under-fill a bundle than to overflow a small-window model.
const DEFAULT_MAX_BUNDLE_TOKENS = 80_000;

let limitsCache: Record<string, ModelLimits> | null = null;

function loadLimitsMapSync(): Record<string, ModelLimits> {
  if (limitsCache) return limitsCache;

  // The believed-limits map (gemini-tier-limits.json) ships WITH the code -- it is bundled
  // reference data, not optional user state. A missing or malformed map is a setup/integrity
  // error, not a routine condition, so we FAIL LOUDLY (throw -> caught at the runAsCli
  // boundary -> stderr + exit 2) rather than silently degrading to an empty map (which would
  // make every model "unknown" and quietly drop limit enforcement). The two failure modes
  // get distinct messages so the cause is obvious.
  let raw: string;
  try {
    raw = readFileSync(LIMITS_MAP_PATH, "utf8");
  } catch (e) {
    throw new CliUsageError(
      `gemini-tier-limits.json could not be read at ${LIMITS_MAP_PATH} ` +
        `(${(e as Error).message}). This file ships with the gemini client; a missing copy ` +
        `usually means an incomplete checkout.`,
    );
  }
  let parsed: { models?: Record<string, ModelLimits> };
  try {
    parsed = JSON.parse(raw) as { models?: Record<string, ModelLimits> };
  } catch (e) {
    throw new CliUsageError(
      `gemini-tier-limits.json is not valid JSON (${LIMITS_MAP_PATH}): ${(e as Error).message}. ` +
        `Fix the file's syntax.`,
    );
  }
  if (parsed.models === undefined || typeof parsed.models !== "object") {
    throw new CliUsageError(
      `gemini-tier-limits.json (${LIMITS_MAP_PATH}) is missing a top-level "models" object.`,
    );
  }
  limitsCache = parsed.models;
  return limitsCache;
}

/** The believed RPD for a model from the map (null if not present). */
export async function mapRpd(model: string): Promise<number | null> {
  return loadLimitsMapSync()[model]?.rpd ?? null;
}

/** The curated set of model names in the limits map (the models we call). */
export function mapModelNames(): string[] {
  return Object.keys(loadLimitsMapSync());
}

/**
 * The discoverable per-model bundle ceiling, in TOKENS. The effective max one call
 * may send is the MIN of the limits that bind a single request:
 *   - input_token_limit -- the model's context window (hard per-request wall)
 *   - tpm -- tokens/min; a single call larger than this alone exceeds the minute
 *            budget and 429s, so it caps a single bundle too
 * Null fields are ignored (e.g. Gemma has tpm=null=unlimited -> only the input
 * window binds). On Tier 1 (tpm 4M > input 1M) the input window binds instead --
 * the min() adapts automatically when the map values change. Model absent from the
 * map -> DEFAULT_MAX_BUNDLE_TOKENS.
 */
export function maxBundleTokensFor(model: string): number {
  const m = loadLimitsMapSync()[model];
  if (!m) return DEFAULT_MAX_BUNDLE_TOKENS;
  const candidates = [m.input_token_limit, m.tpm].filter(
    (v): v is number => typeof v === "number" && v > 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : DEFAULT_MAX_BUNDLE_TOKENS;
}

/**
 * The thinking modes for a model, from the curated map (ProviderClient contract).
 * Returns OUR `default` (the curated `model_default` provenance is NOT surfaced).
 * A model absent from the map, or one with no `thinking` block, is treated as
 * having no thinking control (kind:"none") -- the safe default: call() then sends
 * no thinkingConfig, which never 400s. min/max pass through for the "budget" kind.
 */
export function thinkingModesFor(model: string): ThinkingModes {
  const t = loadLimitsMapSync()[model]?.thinking;
  if (!t) return { kind: "none", default: "", available: [] };
  return {
    kind: t.kind,
    default: t.default,
    available: t.available,
    ...(typeof t.min === "number" ? { min: t.min } : {}),
    ...(typeof t.max === "number" ? { max: t.max } : {}),
  };
}

/**
 * Resolve the EFFECTIVE rpd limit: revealed (sidecar) wins, else believed (map),
 * else null. This is the number the gate enforces against.
 */
export async function effectiveLimit(b: Budget): Promise<number | null> {
  if (b.rpd_limit !== null) return b.rpd_limit; // revealed by a 429 -> ground truth
  return await mapRpd(b.model); // believed from the dashboard, or null
}

function defaultBudget(model: string, today: string): Budget {
  return {
    tier: "free",
    model,
    rpd_limit: null, // not yet revealed; the gate falls back to the map
    rpd_used: 0,
    rpd_window_start: today,
    last_429: null,
  };
}

// Google free-tier RPD quota resets at midnight Pacific (America/Los_Angeles), NOT
// UTC. The window key must therefore be the Pacific calendar date, or the counter
// mismatches Google's reset by up to ~8h every day (false starvation or overshoot).
const RPD_RESET_TZ = "America/Los_Angeles";

// "YYYY-MM-DD" for the RPD window, in the reset timezone. Takes `now` as an arg so
// it stays testable and deterministic (no hidden Date.now()).
//
// No single built-in does "ISO date in a timezone": Date.toISOString() is ISO but
// UTC-only; Temporal would do it natively but is not in bun's JSC engine yet; Intl
// handles the timezone but has no ISO-output option. So we use Intl ONLY as the
// timezone calculator (it correctly handles Pacific incl. DST) and assemble the ISO
// YYYY-MM-DD layout ourselves -- locale-independent (we read named parts, not the
// locale's default format). When JSC ships Temporal this becomes a one-liner.
export function todayStr(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RPD_RESET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---------------------------------------------------------------------------
// CROSS-MACHINE RECONCILIATION. detectConflicts is a pure read; reconcileConflicts
// MUTATES (atomic-write + unlink) and is therefore called ONLY from inside
// withBudgetLock, after the corrupt-file check -- never from the lock-free read path
// (a lock-free reconcile would clobber a corrupt file before the corrupt check fires,
// and race concurrent writers). reconcile is lock-serialized and corrupt-gated.
// ---------------------------------------------------------------------------

// Runtime shape guard for a parsed conflict file: a JSON value that parsed but is not
// a well-formed Budget is rejected, so a missing/typed-wrong field can never poison
// the fold (e.g. undefined rpd_used -> Math.max NaN).
function isValidBudget(x: unknown): x is Budget {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.tier === "string" &&
    typeof b.model === "string" &&
    typeof b.rpd_used === "number" &&
    Number.isFinite(b.rpd_used) &&
    typeof b.rpd_window_start === "string" &&
    (b.rpd_limit === null || typeof b.rpd_limit === "number") &&
    (b.last_429 === null || typeof b.last_429 === "string")
  );
}

/**
 * Detect file-sync conflict copies left beside the budget file. Many sync tools name
 * conflict copies `<name>.sync-conflict-<date>-<time>-<id>.<ext>` (inserting the marker
 * before the extension) -- so for a budget file `gemini-budget-<model>.json`, conflicts
 * are `gemini-budget-<model>.sync-conflict-*`. Returns full paths, [] if none.
 */
export async function detectConflicts(budgetPath: string): Promise<string[]> {
  const dir = dirname(budgetPath);
  const base = basename(budgetPath);
  const stem = base.replace(/\.json$/, ""); // gemini-budget-<model>
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // dir unreadable -> no conflicts we can act on
  }
  return entries
    .filter((e) => e.startsWith(`${stem}.sync-conflict-`))
    .map((e) => join(dir, e));
}

/**
 * Merge conflict copies into the current budget conservatively, then rewrite the
 * canonical file atomically and delete the conflict copies. The fold (with a window
 * guard):
 *   - rpd_window_start = the LATEST window across all versions (current + conflicts).
 *   - rpd_used = MAX rpd_used among ONLY the versions already on that latest window.
 *     (A version from an OLDER window is yesterday's tally -- its count must NOT be
 *     dragged into today. Plain MAX across versions would over-count across the
 *     midnight-PT boundary; this window-guard prevents that while still never
 *     under-counting WITHIN a day -- the conservative-but-correct reading.)
 *   - rpd_limit = a revealed (non-null) limit if ANY version has one (a 429 anywhere
 *     taught the real cap; ground truth, keep it).
 *   - last_429 = the LATEST last_429 across all versions.
 * Unparseable conflict files are skipped in the fold but still deleted (corrupt sync
 * artifacts -- the real data is in the other versions). The canonical file's own
 * corruption is handled upstream by the corrupt-file check, not here.
 */
export async function reconcileConflicts(current: Budget, conflictPaths: string[]): Promise<Budget> {
  if (conflictPaths.length === 0) return current;

  // Gather VALID versions (current + conflicts that parse AND have the right shape).
  // A conflict file that parses as JSON but has the wrong shape (missing/typed-wrong
  // fields) is skipped -- otherwise an `undefined` rpd_used would poison Math.max(NaN).
  const versions: Budget[] = [current];
  for (const p of conflictPaths) {
    try {
      const parsed = JSON.parse(await readFile(p, "utf8")) as unknown;
      if (isValidBudget(parsed)) versions.push(parsed);
      // else: parseable but malformed -> skip in fold (still deleted below)
    } catch {
      /* unparseable conflict copy -> skip in fold (still deleted below) */
    }
  }

  // Latest window across all versions (string compare works on YYYY-MM-DD).
  const latestWindow = versions.reduce(
    (acc, v) => (v.rpd_window_start > acc ? v.rpd_window_start : acc),
    versions[0]!.rpd_window_start,
  );

  // MAX rpd_used among ONLY the versions on that latest window (window guard).
  const usedOnLatest = versions
    .filter((v) => v.rpd_window_start === latestWindow)
    .map((v) => v.rpd_used);
  const mergedUsed = usedOnLatest.length > 0 ? Math.max(...usedOnLatest) : 0;

  // Revealed limits are ground truth (a 429 taught them). If two machines learned
  // DIFFERENT limits, take the MIN -- the lowest revealed cap is the most
  // conservative: it denies earliest and never lets the cluster exceed the smallest
  // ceiling any machine observed (a too-high kept limit would under-deny -> overspend,
  // the dangerous direction for a limiter). Deterministic, unlike "first non-null".
  const revealed = versions.map((v) => v.rpd_limit).filter((l): l is number => l !== null);
  const mergedLimit = revealed.length > 0 ? Math.min(...revealed) : null;

  // Latest last_429 (ISO UTC strings compare lexicographically); null if none.
  // NOTE: last_429 is a full UTC ISO timestamp, whereas rpd_window_start is a Pacific
  // calendar date -- different timezones. Each is compared only against its own kind
  // here, which is correct; do NOT cross-compare last_429 with rpd_window_start.
  const merged429 = versions.reduce<string | null>((acc, v) => {
    if (v.last_429 === null) return acc;
    if (acc === null) return v.last_429;
    return v.last_429 > acc ? v.last_429 : acc;
  }, null);

  const merged: Budget = {
    tier: current.tier,
    model: current.model,
    rpd_limit: mergedLimit,
    rpd_used: mergedUsed,
    rpd_window_start: latestWindow,
    last_429: merged429,
  };

  // Delete the consumed conflict copies (cleanup). The MERGED value is RETURNED, not
  // written here: the caller (withBudgetLock, lock-held) applies its mutation to this
  // merged base and writes the final value once -- no redundant double-write. Deleting
  // the copies here is safe: we hold the lock, and we have already read their contents
  // into `merged`.
  for (const p of conflictPaths) {
    try {
      await unlink(p);
    } catch {
      /* already gone / unremovable -> best-effort cleanup */
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Atomic write: write a temp file then rename() over the target (rename is atomic
// on the same filesystem, so a reader never sees a half-written file). This is
// READER-safety (no torn reads), orthogonal to the lock's WRITER-safety.
//
// Temp name uses process.pid as the uniqueness token. This is SUFFICIENT because
// every real caller of this code runs as its OWN forked OS process: the budget
// functions are only ever reached via `bun <script>.ts ...`, and every such
// invocation -- including concurrent sibling invocations -- forks a distinct child
// process with a distinct PID. So two concurrent writers can never share a PID, and
// `.tmp-${pid}` never collides. (The main read-modify-write is additionally lock-
// serialized; only the once-per-model pre-lock bootstrap create is lock-free, and
// even it is PID-distinct.)
//
// The ONLY way to break this would be a NEW caller that imports these functions
// directly and runs concurrent same-model writes IN ONE process (e.g.
// Promise.all([recordRequest(m), recordRequest(m)]) or a Worker) -- which nothing
// does and would be an unusual thing to build. If such a caller is ever added,
// append a per-write counter/uuid to `tmp` to restore uniqueness within a PID.
// ---------------------------------------------------------------------------
async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

// A read either yields a usable Budget or flags the on-disk file as corrupt.
// `corrupt` = the file EXISTS and is non-empty but did not parse. This must NOT be
// silently overwritten with a zeroed default: a transient partial read (mid-sync,
// crash-during-write) would otherwise WIPE a real high count and reopen the gate
// (rpd_limit -> null) exactly under the sync/concurrency conditions this file exists
// to survive. So we surface corruption and let callers preserve, not clobber.
interface BudgetRead {
  budget: Budget;
  corrupt: boolean;
}

async function readBudgetRaw(model: string, today: string): Promise<BudgetRead> {
  const path = budgetPathFor(model);
  if (!existsSync(path)) {
    return { budget: defaultBudget(model, today), corrupt: false };
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // Could not even read the bytes -> treat as a fresh default, not corrupt (there
    // is nothing on disk we can point to as worth preserving from this process).
    return { budget: defaultBudget(model, today), corrupt: false };
  }
  if (raw.trim() === "") {
    // Empty file -> genuinely nothing to preserve; treat as fresh.
    return { budget: defaultBudget(model, today), corrupt: false };
  }
  try {
    return { budget: JSON.parse(raw) as Budget, corrupt: false };
  } catch {
    // Non-empty but unparseable -> CORRUPT. Return a conservative default for reads,
    // but flag it so a mutating caller refuses to overwrite the real (recoverable)
    // bytes. Conservative default keeps rpd_limit null (caller warns) without
    // claiming the counter is zero authoritatively.
    return { budget: defaultBudget(model, today), corrupt: true };
  }
}

/**
 * Read the current budget, routing through the conflict seam, and roll the RPD
 * window if the day changed. Does NOT take the lock -- callers that mutate use
 * withBudgetLock(). Returns the on-disk `corrupt` flag so mutating callers can
 * refuse to clobber unparseable-but-recoverable bytes.
 */
export async function readBudgetChecked(model: string, now: Date): Promise<BudgetRead> {
  const today = todayStr(now);
  const read = await readBudgetRaw(model, today);
  const budget = read.budget;

  // PURE READ -- no reconcile here. Cross-machine reconciliation MUTATES (write +
  // unlink) and runs ONLY inside withBudgetLock, lock-held and after the corrupt
  // check (a lock-free reconcile here would clobber a corrupt file before the corrupt
  // check fires and race concurrent writers). This path is the non-authoritative
  // pre-call gate; an un-reconciled read is harmless (it self-corrects at the next
  // write, which reconciles).

  // Roll the RPD window on a new day.
  if (budget.rpd_window_start !== today) {
    budget.rpd_window_start = today;
    budget.rpd_used = 0;
  }
  return { budget, corrupt: read.corrupt };
}

/** Convenience read that drops the corrupt flag (for pre-call gating). */
export async function readBudget(model: string, now: Date): Promise<Budget> {
  return (await readBudgetChecked(model, now)).budget;
}

/**
 * Pre-call check: is there RPD headroom? Uses the EFFECTIVE limit (revealed sidecar
 * value wins, else the believed map value, else null). When the effective limit is
 * still null (unknown), allow but flag (the caller may warn). When known and
 * exhausted, deny. Async because the map read is async.
 */
export async function hasHeadroom(b: Budget): Promise<{
  ok: boolean;
  unknownLimit: boolean;
  limit: number | null;
}> {
  const limit = await effectiveLimit(b);
  if (limit === null) return { ok: true, unknownLimit: true, limit: null };
  return { ok: b.rpd_used < limit, unknownLimit: false, limit };
}

/**
 * Run a read-modify-write under the same-machine lock. Best-effort: if the lock
 * cannot be acquired quickly, SKIP the write (a lost increment is the already-
 * tolerated residual; never block a call on the budget counter). Returns the
 * mutated budget.
 */
/** Result of a budget mutation: the (best-effort) budget value + whether the write
 *  was actually persisted. recorded=false means the increment was SKIPPED (lock
 *  contention or corrupt-file preservation) -- the caller should surface a note. */
export interface BudgetWrite {
  budget: Budget;
  recorded: boolean;
  note?: string;
}

export async function withBudgetLock(
  model: string,
  now: Date,
  mutate: (b: Budget) => Budget,
): Promise<BudgetWrite> {
  const path = budgetPathFor(model);
  // Ensure the file exists before locking it (proper-lockfile locks a real path).
  // KNOWN TOCTOU (accepted, minimal risk): this existsSync/create is OUTSIDE the
  // lock, so two contexts racing on a brand-NEW file could both create a default.
  // Exposure is first-run-only (the branch never fires once the file exists) and on
  // a zeroed file (worst case = a default overwrites a default, or a couple of
  // increments lost at ~0 count). Not worth the complexity of an atomic create-lock
  // for a one-time, parallel-only, near-zero-impact window. Accepted.
  if (!existsSync(path)) {
    await atomicWrite(path, JSON.stringify(defaultBudget(model, todayStr(now))));
  }

  // MUST-acquire (retry generously, then SKIP -- never write lock-free). A budget
  // write is microseconds, so the retry window (~8 tries, 25-250ms) wins virtually
  // always. If the lock genuinely cannot be acquired (a stuck/stale lock), we SKIP
  // the write rather than writing lock-free -- a skipped increment is the tolerated
  // residual, and skipping eliminates the lock-free corruption race entirely (there
  // is no unsynchronized write path). We never block: this runs AFTER the API call
  // returned, so the call already succeeded; the only cost of a skip is one uncounted
  // request, surfaced to the caller via `recorded:false`.
  let release: (() => Promise<void>) | null = null;
  try {
    // Lazy import (see the note at the top of this file): keeps proper-lockfile out
    // of the static module graph. By the time any code reaches withBudgetLock, deps
    // have been gated upstream (GeminiClient.ensureDeps), so this import resolves; if
    // it somehow does not, the catch below SKIPs the write (recorded:false) -- the
    // same tolerated residual as lock contention.
    const lockfile = (await import("proper-lockfile")).default;
    release = await lockfile.lock(path, {
      retries: { retries: 8, minTimeout: 25, maxTimeout: 250 },
      stale: 10_000,
    });
  } catch {
    // Genuinely could not acquire -> SKIP the write (do not write lock-free).
    const { budget: current } = await readBudgetChecked(model, now);
    const next = mutate(current);
    return {
      budget: next,
      recorded: false,
      note: "budget increment not recorded (lock contention); daily count may be slightly under",
    };
  }

  try {
    const { budget: read, corrupt } = await readBudgetChecked(model, now);
    if (corrupt) {
      // The on-disk file exists, is non-empty, and did not parse -- almost certainly
      // a transient partial/sync artifact. Do NOT overwrite it with our zeroed-
      // default-derived value, which would permanently wipe a real count and reopen
      // the gate. Skip the write AND skip reconcile (reconcile would also overwrite
      // the corrupt bytes). The real bytes survive for the next clean read.
      return {
        budget: mutate(read),
        recorded: false,
        note: "budget not recorded (on-disk file unparseable; preserved to avoid wiping a real count)",
      };
    }

    // Cross-machine reconciliation -- LOCK-HELD, file is not corrupt. Merge any
    // file-sync conflict copies into the current value (and delete them) BEFORE
    // applying our mutation, so our increment lands on the reconciled base.
    let current = read;
    const conflicts = await detectConflicts(path);
    if (conflicts.length > 0) {
      current = await reconcileConflicts(current, conflicts);
    }

    const next = mutate(current);
    await atomicWrite(path, JSON.stringify(next));
    return { budget: next, recorded: true };
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        /* lock already gone -- fine */
      }
    }
  }
}

/** Increment rpd_used by one (the post-successful-call mutation). */
export async function recordRequest(model: string, now: Date): Promise<BudgetWrite> {
  return withBudgetLock(model, now, (b) => ({ ...b, rpd_used: b.rpd_used + 1 }));
}

/**
 * Record an observed 429 and, if provided, learn the rpd_limit from it.
 *
 * When a 429 teaches the limit, also raise rpd_used to AT LEAST that limit. A 429
 * means Google considers the quota spent, but our counter may read lower (the
 * tolerated lost-increment residual). Without this, hasHeadroom would report phantom
 * headroom right after learning the limit and let calls through until the next 429.
 * Clamping rpd_used up to the limit makes the deny stick immediately.
 */
export async function record429(model: string, now: Date, learnedLimit?: number): Promise<BudgetWrite> {
  return withBudgetLock(model, now, (b) => {
    const rpd_limit = learnedLimit ?? b.rpd_limit;
    const rpd_used =
      learnedLimit !== undefined ? Math.max(b.rpd_used, learnedLimit) : b.rpd_used;
    return { ...b, last_429: now.toISOString(), rpd_limit, rpd_used };
  });
}
