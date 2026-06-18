# Runbook -- how to execute one analysis run

Quick-start ordered procedure. Survives compaction: if you're picking this up cold, this is the
single source for "do 1, 2, 3." METHODOLOGY.md is the *why*; this is the *how*. (Eventual basis for
a skill; for now it's a checklist.)

**Component root:** `~/code/ai-tools/agent-session-analysis/`
**Defaults:** KB_ROOT = `~/ClaudeDesktop`, min human prompts = 5, timezone = system local.

---

## Where the files live (inputs)

Before step 0, know your two roots:

- **Transcripts (the data you analyze):** Claude Code writes one JSONL transcript per session under
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. `<encoded-cwd>` is the session's working
  directory with `/` turned into `-` (e.g. a session run in `/home/alice/work` lands under
  `~/.claude/projects/-home-alice-work/`). Sub-agent/workflow transcripts live deeper under
  `.../<parent-uuid>/subagents/agent-*.jsonl` and are intentionally NOT scanned (v1 is top-level
  sessions only). The `--scan` argument points at the `projects` dir; selection is by file mtime
  within the window.
- **KB_ROOT (what counts as "knowledge-base" usage):** the directory tree whose files are counted as
  KB reads/writes. Defaults to `~/ClaudeDesktop`; override with `--kb-root` if your KB lives
  elsewhere. Tool calls touching paths OUTSIDE this root are ordinary tool calls, not KB usage.

The per-session project label is derived from `<encoded-cwd>` with your home fragment stripped. That
fragment defaults to one derived from `$HOME` (e.g. `-home-alice-`); override with `--home-prefix`
only when analyzing transcripts logged under a different home than the one running the script.

---

## 0. Pick the window

One run = one date range, `YYYY-MM-DD`, local time, inclusive. Windows are selected by file **mtime**
(documented limitation: window edges are fuzzy -- see METHODOLOGY "What counts as a session").

**If the user did not specify a date range, ASK them for one before doing anything else** (start and
end dates, `YYYY-MM-DD`). Do not assume or default a window -- there is no "next run" to infer.

The run dir is **auto-created** as `runs/<start>_<end>[_N]/` and never clobbers an existing one, so a
re-run of a window that already has a dir lands in a fresh `_N` sibling rather than overwriting.

---

## 1. Deterministic pass (metrics + temporal + run-meta)

```
cd ~/code/ai-tools/agent-session-analysis
python3 Tools/extract-session-metrics.py --scan ~/.claude/projects \
    --start <START> --end <END> --min-users 5 --out runs/
```

Writes into the auto-created run dir: `metrics.json`, `temporal.json`, `run-meta.json`, `run-meta.md`.
Read `run-meta.md` first -- it's the glanceable sanity check (session count, agent-time, skips).

**Sanity-check before continuing:** open `run-meta.md`. Does the session count look plausible? Did
the sentinel/skip counts behave? If a number looks wrong, stop and investigate -- don't fanout on bad
selection.

---

## 2. Build the fanout input (judgement layer)

The fanout agents need a per-session list: `{path, proj, users, sizeKB, first, kb_class_counts}`.
Derive it from `metrics.json` (sizeKB from on-disk file size; the rest from each session record).

```
python3 - <<'PY'
import json, os
m = json.load(open('runs/<START>_<END>/metrics.json'))
out=[]
for s in m['sessions']:
    out.append({"path": s['path'], "proj": s.get('proj',''), "users": s.get('users',0),
                "sizeKB": round(os.path.getsize(s['path'])/1024) if os.path.exists(s['path']) else 0,
                "first": (s.get('first') or '')[:80],
                "kb_class_counts": s.get('kb_class_counts') or {}})
json.dump(out, open('/tmp/fanout-input.json','w'))
print(len(out),'sessions')
PY
```

---

## 3. Run the fanout

**CRITICAL GOTCHA:** the Workflow `args` global does NOT reliably reach the script. Hit this 3x.
**EMBED the session list as a `const` literal in the driver** -- do not pass via `args`.

Procedure: copy `Tools/classify-and-estimate.workflow.js` to `/tmp/`, replace `const sessions =
args.sessions` with the literal array (paste the contents of `/tmp/fanout-input.json`), set
`KB_ROOT`, then `Workflow({scriptPath: "/tmp/<driver>.js"})`.

The driver returns `{count, sessions, errors}` wrapped in a Workflow `result` envelope. If it hits
the session token limit mid-run, some sessions come back as error stubs (missing `work_type_primary`)
-- re-run just those after the token reset, embedding only the missing subset, then merge by `path`.

Save the merged result as `runs/<START>_<END>/judgements.json` (all sessions, each with a
`work_type_primary`).

---

## 4. Join + write the report

Join `judgements.json` to `metrics.json` by `path` -> the joined view is what the report is written
from. Then hand-author `runs/<START>_<END>/report.md` following the **`## Report generation`** section
in METHODOLOGY.md: the 10-section skeleton, three tiers (MEASURED/CLASSIFIED/INDICATIVE) kept
separate, claim discipline, tentative-conclusions-with-confidence. Pull the report header straight
from `run-meta.json` so it can't drift.

---

## 5. Wrap up

- Record the run's outcome and any new gotchas in your own status/notes log (kept outside this repo
  alongside the run data).
- Multi-run note: only MEASURED tiers compare directly across runs; CLASSIFIED/INDICATIVE comparisons
  are directional. Two runs compare; they do not establish a trend.

---

## Versioning / safety notes

- Script changelog lives in this repo's git history. When the *method* changes, bump the methodology
  version in METHODOLOGY.md so older runs stay interpretable against the spec that produced them.
- **Privacy:** this component (methodology + tools) is the shareable part and lives in a public
  repo. Run data under `runs/` is NOT -- transcripts carry real repo names, session IDs, and prompt
  excerpts. Keep `runs/` local (it is git-ignored here); never commit or publish run output as-is.
- Self-exclusion: a session containing the sentinel string is auto-dropped. Historical windows
  naturally exclude the current analysis session anyway (it's "today").
