#!/usr/bin/env bun
// Distill Claude Code session transcript JSONL into "dialogue spines" for friction mining.
//
// Keeps: user prompts, assistant text, tool-call names (input briefs), tool ERRORS and
// user rejections/interrupts, queued mid-turn user messages, compaction boundaries.
// Drops: tool outputs, hook attachments, injected skill payloads (marked), system-reminder
// blocks (marked). The result is typically ~5% of raw size and is what the mining agents read.
//
// Usage:
//   bun distill-transcripts.v1.ts --out ./distilled [--projects-dir ~/.claude/projects]
//       [--window-days 7] [--exclude-session <uuid>]... [--batch-bytes 140000] [--force-git-tree]
//
// Notes:
// - ALWAYS pass --exclude-session with the session id of the analysis session itself,
//   or the analysis will ingest its own transcript.
// - Refuses to write output inside a git work tree unless --force-git-tree is given:
//   spines contain real prompt excerpts and must never end up in a (potentially public) repo.
// - Window is selected by file mtime (cheap; edges are fuzzy for long-running sessions).
// - All timestamps in spines are UTC (sliced from the transcript's ISO timestamps).
// - Batches group ALL distilled sessions (multi-turn AND single-prompt: abandon/retry
//   friction lives in the single-prompt ones), never straddling a project boundary,
//   chronological within project, so miners can spot abandon->retry across adjacent sessions.
// - batches.json is written as {"batches": [...]} to match the workflow loader's schema.
// - Paths in batches.json are ABSOLUTE (fan-out agents run with unpredictable working
//   directories; relative paths WILL lose files).

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename, resolve, dirname } from "path";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: bun distill-transcripts.v1.ts --out <dir> [--projects-dir <dir>] [--window-days N] [--exclude-session <uuid>]... [--batch-bytes N] [--force-git-tree]");
  console.log("Distills Claude Code session JSONL into dialogue spines + batches for friction mining.");
  console.log("ALWAYS pass --exclude-session <id-of-the-analysis-session>. Output contains real prompt excerpts:");
  console.log("the tool refuses to write inside a git work tree unless --force-git-tree is given.");
  process.exit(0);
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function argVal(flag: string, dflt: string | null): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) { return dflt; }
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) { die(`flag ${flag} requires a value (got ${v ?? "nothing"})`); }
  return v;
}
function argAll(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag) {
      const v = process.argv[i + 1];
      if (v === undefined || v.startsWith("--")) { die(`flag ${flag} requires a value`); }
      out.push(v);
    }
  }
  return out;
}
function argNum(flag: string, dflt: number): number {
  const raw = argVal(flag, String(dflt))!;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) { die(`flag ${flag} must be a positive number (got "${raw}")`); }
  return n;
}

const projectsDirArg = argVal("--projects-dir", null);
const PROJECTS_DIR = projectsDirArg
  ?? (process.env.HOME ? join(process.env.HOME, ".claude", "projects")
      : die("HOME is not set; pass --projects-dir explicitly"));
const OUT_DIR = resolve(argVal("--out", "./distilled")!);
const WINDOW_DAYS = argNum("--window-days", 7);
const EXCLUDE_SESSIONS = new Set(argAll("--exclude-session"));
const TARGET_BATCH_BYTES = argNum("--batch-bytes", 140000);
const USER_CAP = 4000, ASSISTANT_CAP = 2500, ERR_CAP = 400;

// Never write prompt excerpts into a (potentially public) repo working tree by accident.
if (!process.argv.includes("--force-git-tree")) {
  for (let p = OUT_DIR; ; ) {
    if (existsSync(join(p, ".git"))) {
      die(`refusing to write output inside a git work tree (${p}). Choose an --out outside any repo, or pass --force-git-tree if this tree is private and you mean it.`);
    }
    const parent = dirname(p);
    if (parent === p) { break; }
    p = parent;
  }
}

const cutoff = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
mkdirSync(OUT_DIR, { recursive: true });

type Entry = {
  file: string; project: string; sessionId: string;
  start: string | null; end: string | null;
  realUserPrompts: number; interrupts: number; toolErrors: number; rejections: number;
  compactions: number; rawBytes: number; distilledBytes: number; distilledPath: string | null;
  bucket: "multi-turn" | "single-prompt" | "skipped"; skipReason?: string;
};

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + ` ...[truncated ${s.length - n} chars]`;
}

const INTERRUPT_RE = /\[Request interrupted by user/;

function cleanUserText(t: string): { text: string; isRealPrompt: boolean } {
  if (t.startsWith("Base directory for this skill:")) {
    return { text: `[skill payload: ${t.split("\n").find(l => l.startsWith("#")) ?? t.slice(0, 80)}]`, isRealPrompt: false };
  }
  if (t.startsWith("<task-notification>")) {
    return { text: "", isRealPrompt: false }; // suppressed in the spine; not a human prompt
  }
  const stripped = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "[system-reminder]").trim();
  // Interrupt markers are supervision actions, not prompts; keep the line, don't count it.
  const isReal = !INTERRUPT_RE.test(stripped)
    && stripped.replace(/\[system-reminder\]/g, "").trim().length > 0;
  return { text: stripped, isRealPrompt: isReal };
}

const index: Entry[] = [];
let excludedCount = 0, unparseableCount = 0;

let topDirs: string[];
try { topDirs = readdirSync(PROJECTS_DIR); }
catch { die(`projects dir not found or unreadable: ${PROJECTS_DIR} (pass --projects-dir)`); }

for (const dir of topDirs) {
  // Explicitly ignore sub-agent transcripts: sub-agents are generally non-interactive with
  // the user, so they are not primary human-agent interaction units (friction with a
  // delegation surfaces in the parent session). Note the scan is deliberately non-recursive,
  // which is also what keeps nested per-session subagent transcripts out.
  if (dir === "subagents") { continue; }
  const dirPath = join(PROJECTS_DIR, dir);
  let files: string[];
  try { files = readdirSync(dirPath).filter(f => f.endsWith(".jsonl")); } catch { continue; }

  for (const f of files) {
    const fp = join(dirPath, f);
    let st;
    try { st = statSync(fp); } catch { continue; } // rotated/deleted mid-scan
    if (st.mtimeMs < cutoff) { continue; }
    const sessionId = basename(f, ".jsonl");
    const entry: Entry = {
      file: fp, project: dir, sessionId, start: null, end: null,
      realUserPrompts: 0, interrupts: 0, toolErrors: 0, rejections: 0, compactions: 0,
      rawBytes: st.size, distilledBytes: 0, distilledPath: null, bucket: "skipped",
    };
    if (EXCLUDE_SESSIONS.has(sessionId)) {
      entry.skipReason = "excluded via --exclude-session"; excludedCount++; index.push(entry); continue;
    }

    const out: string[] = [];
    let parsed = 0;
    for (const line of readFileSync(fp, "utf8").split("\n")) {
      if (!line.trim()) { continue; }
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      parsed++;
      const ts: string | undefined = o.timestamp;
      if (ts) { if (!entry.start) { entry.start = ts; } entry.end = ts; }
      const t = ts ? ts.slice(5, 16).replace("T", " ") : "??";

      if (o.type === "queue-operation" && o.operation === "enqueue") {
        const c = String(o.content ?? "");
        if (!c.startsWith("<task-notification>")) { out.push(`USER (queued) [${t}]: ${cap(c, USER_CAP)}\n`); }
        continue;
      }
      if (o.type === "system" && o.subtype === "compact_boundary") {
        entry.compactions++; out.push(`[COMPACTION BOUNDARY ${t}]\n`); continue;
      }
      if (o.type !== "user" && o.type !== "assistant") { continue; }
      if (o.isSidechain) { continue; }
      const content = o.message?.content;
      if (o.type === "user") {
        if (typeof content === "string") {
          const { text, isRealPrompt } = cleanUserText(content);
          if (INTERRUPT_RE.test(content)) { entry.interrupts++; }
          if (isRealPrompt) { entry.realUserPrompts++; }
          if (text) { out.push(`USER [${t}]: ${cap(text, USER_CAP)}\n`); }
        } else if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === "text") {
              const raw = String(b.text ?? "");
              const { text, isRealPrompt } = cleanUserText(raw);
              if (INTERRUPT_RE.test(raw)) { entry.interrupts++; }
              if (isRealPrompt) { entry.realUserPrompts++; }
              if (text && !text.startsWith("[skill payload")) {
                out.push(`USER [${t}]: ${cap(text, USER_CAP)}\n`);
              } else if (text.startsWith("[skill payload")) {
                out.push(`${text}\n`);
              }
            } else if (b.type === "tool_result") {
              const raw = typeof b.content === "string" ? b.content
                : Array.isArray(b.content) ? b.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ") : "";
              const rejected = /doesn't want to proceed|user rejected|User declined|interrupted by user/i.test(raw);
              if (rejected) { entry.rejections++; out.push(`[TOOL REJECTED/INTERRUPTED] [${t}]: ${cap(raw, ERR_CAP)}\n`); }
              else if (b.is_error) { entry.toolErrors++; out.push(`[TOOL ERROR] [${t}]: ${cap(raw, ERR_CAP)}\n`); }
            }
          }
        }
      } else { // assistant
        if (!Array.isArray(content)) { continue; }
        for (const b of content) {
          if (b.type === "text" && b.text?.trim()) { out.push(`ASSISTANT [${t}]: ${cap(b.text.trim(), ASSISTANT_CAP)}\n`); }
          else if (b.type === "tool_use") {
            let brief = "";
            try { brief = JSON.stringify(b.input).slice(0, 160); } catch {}
            out.push(`  -> ${b.name}: ${brief}\n`);
          }
        }
      }
    }

    if (parsed === 0) { entry.skipReason = "unparseable/empty"; unparseableCount++; index.push(entry); continue; }
    entry.bucket = entry.realUserPrompts >= 2 ? "multi-turn" : "single-prompt";
    const header = `=== SESSION ${sessionId} ===\nproject: ${dir}\nspan (UTC): ${entry.start} .. ${entry.end}\nrealUserPrompts: ${entry.realUserPrompts} | interrupts: ${entry.interrupts} | toolErrors: ${entry.toolErrors} | rejections: ${entry.rejections} | compactions: ${entry.compactions}\n\n`;
    const body = header + out.join("");
    const op = join(OUT_DIR, `${dir}__${sessionId}.txt`);
    writeFileSync(op, body);
    entry.distilledPath = op; entry.distilledBytes = Buffer.byteLength(body);
    index.push(entry);
  }
}

// Batches: ALL distilled sessions, never straddling a project boundary, chronological
// within project so miners can compare adjacent sessions of the same project.
const all = index.filter(e => e.distilledPath)
  .sort((a, b) => a.project === b.project ? (a.start ?? "").localeCompare(b.start ?? "") : a.project.localeCompare(b.project));
const batches: { id: number; project: string; files: string[]; bytes: number }[] = [];
for (const e of all) {
  const last = batches[batches.length - 1];
  if (last && last.project === e.project && last.bytes + e.distilledBytes <= TARGET_BATCH_BYTES) {
    last.files.push(e.distilledPath!); last.bytes += e.distilledBytes;
  } else {
    batches.push({ id: batches.length + 1, project: e.project, files: [e.distilledPath!], bytes: e.distilledBytes });
  }
}
writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 1));
writeFileSync(join(OUT_DIR, "batches.json"), JSON.stringify({ batches }, null, 1));

const sum = (k: "rawBytes" | "distilledBytes") => index.reduce((a, e) => a + e[k], 0);
const nOf = (b: Entry["bucket"]) => index.filter(e => e.bucket === b).length;
console.log(`sessions: ${index.length} | multi-turn: ${nOf("multi-turn")} | single-prompt: ${nOf("single-prompt")} | excluded: ${excludedCount} | unparseable: ${unparseableCount}`);
console.log(`raw: ${(sum("rawBytes") / 1e6).toFixed(1)}MB -> distilled: ${(sum("distilledBytes") / 1e6).toFixed(1)}MB in ${batches.length} batches`);
console.log(`interrupts: ${index.reduce((a, e) => a + e.interrupts, 0)} | rejections: ${index.reduce((a, e) => a + e.rejections, 0)} | toolErrors: ${index.reduce((a, e) => a + e.toolErrors, 0)} | compactions: ${index.reduce((a, e) => a + e.compactions, 0)}`);
