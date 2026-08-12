# Runbook -- one friction-analysis run

Ordered procedure. METHODOLOGY.md is the why; this is the do-1-2-3.

**Prereq:** bun; jq; a Claude Code session driving the run (it executes the Workflow fan-out and writes the synthesis).

## 0. Pick the window and a workdir

One run = one window (`--window-days` back from now, mtime-selected). Create a private scratch/work directory OUTSIDE this repo -- run output never lives in this tree. Note your driving session's own session id (the UUID in its transcript path or scratchpad path): it MUST be excluded.

## 1. Distill (deterministic)

```
bun Tools/distill-transcripts.v1.ts \
    --out <workdir>/distilled \
    --window-days 7 \
    --exclude-session <this-analysis-session-uuid>
```

Sanity-check the printed summary: session count plausible? `excluded: 1` (your own session)? Spot-open one spine. If a count looks wrong, stop and investigate before spending on the fan-out. Check the `bucket` field in `distilled/index.json` (`multi-turn` / `single-prompt` / `skipped`); investigate surprises (e.g. many single-prompt sessions may be the user's intentional one-shot style -- ask, don't assume abandonment). `batches.json` is `{"batches": [...]}` with absolute file paths, grouped per project.

## 2. Fan out (mine + verify)

First: `mkdir <workdir>/findings`. Then:

```
Workflow({ scriptPath: "Workflows/friction-audit.workflow.v1.js",
           args: { scratch: "<workdir>" } })
```

The script fails fast if `args.scratch` did not reach it (a known flaky spot in the Workflow args plumbing); if that recurs, embed the workdir as a const in a private copy of the script. Expect one miner (mid-tier) + one verifier (stronger model) per batch; ~15 batches per 120-ish sessions at default batch size. On completion, confirm every `batch-N.json` has a `batch-N.verified.json` NEXT TO IT -- an agent that resolved a relative path elsewhere is the known failure mode (v1 lesson: absolute paths in briefs; if a file is missing, check the workflow journal for where the agent wrote it, or re-run that one verifier directly with explicit absolute paths).

## 3. Synthesize

- Flatten: `jq -s '[.[] | .batchId as $b | .events[] | . + {batchId: $b}]' findings/*.verified.json > events-all.json`.
- READ the events (all of them, not the summaries), aggregate counts per cause/severity/verdict, dedupe cross-session duplicates of single incidents, and write the report per METHODOLOGY "Synthesis".
- Apply any user exclusions to headline numbers; keep the events tagged.
- Optional: cross-vendor review of a SANITIZED synthesis (counts + definitions + conclusions, zero transcript content) via `../cross-vendor-review/`.

## 4. Archive

Copy to your private runs tree (NOT this repo): the report, `events-all.json`, `findings/`, `distilled/` (the durable input -- raw transcripts expire under harness retention), the sanitized synthesis if made, and the exact script versions used. Write a per-run README: window, corpus stats, headline table, exclusions/steers applied, method learnings. Update your private runs index for cross-run comparison.
