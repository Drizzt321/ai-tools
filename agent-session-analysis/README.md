# agent-session-analysis

Measure, from Claude Code session transcripts, **what an agent actually spends its time doing** --
where the working time goes, how tokens are spent, what kind of work each session was, and how
heavily a knowledge base is read vs. written. The point is an honest, reproducible picture of usage
over a date window, not a vanity "time saved" number.

The design discipline is three epistemic tiers, kept strictly separate:

- **MEASURED** -- observed directly from transcript records (timestamps, tokens, tool calls). No
  estimation, no agent. Produced by the deterministic script; identically re-runnable.
- **CLASSIFIED** -- agent judgement against a fixed taxonomy (work-type per session). Auditable.
- **INDICATIVE** -- soft signal (knowledge-base artifact-class value-lean). Directional, not a claim.

Mixing those tiers is the failure mode this tool exists to avoid. A run materializes each tier into
its own files so they never get conflated in the writeup.

## How to run

See [`RUNBOOK.md`](./RUNBOOK.md) for the ordered procedure (pick a window -> deterministic pass ->
build fanout input -> run fanout -> join + write the report). [`METHODOLOGY.md`](./METHODOLOGY.md) is
the *why* behind every decision (selection rules, the agent-working-time definition incl. the
AskUserQuestion edge, the classification taxonomy, claim discipline).

Quick start:

```
cd ~/code/ai-tools/agent-session-analysis
python3 Tools/extract-session-metrics.py --scan ~/.claude/projects \
    --start 2026-05-21 --end 2026-06-03 --min-users 5 --out runs/
```

That writes a per-run dir under `runs/` (`metrics.json`, `temporal.json`, `run-meta.json`,
`run-meta.md`). The agent fanout (`Tools/classify-and-estimate.workflow.js`) adds the CLASSIFIED /
INDICATIVE judgement layer on top.

## Tools

| File | What it is |
|------|------------|
| [`Tools/extract-session-metrics.py`](./Tools/extract-session-metrics.py) | Deterministic pass (MEASURED tier). Pure Python, zero agent tokens: session selection, human-vs-tool-result classification, agent working-time, tokens, KB read/write counts, per-output timeline, day/hour + overlap temporal analysis, and a glanceable `run-meta.md`. |
| [`Tools/classify-and-estimate.workflow.js`](./Tools/classify-and-estimate.workflow.js) | Agent fanout driver (CLASSIFIED + INDICATIVE tiers). One agent per session returns work-type + KB value-lean judgement only; deterministic metrics are joined by path afterward, never recomputed. |

## Inputs and configuration

- **Transcripts:** `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (point `--scan` at the `projects`
  dir; selection is by file mtime within the window). See RUNBOOK "Where the files live".
- **`--kb-root`** sets what counts as knowledge-base usage (default `~/ClaudeDesktop`). It's the
  parent directory holding your individual project knowledge bases -- one subdirectory per project,
  each based on the [`project-knowledgebase`](../project-knowledgebase/) template (sibling component
  in this repo). The artifact-class ruleset keys on that template's structure, so classification is
  most accurate when the project dirs under `--kb-root` follow it.
- **`--home-prefix`** is the encoded home fragment stripped from project labels; defaults to one
  derived from `$HOME`, so you normally never set it.

## Privacy

Run output under `runs/` is **local-only** -- transcripts carry real repo names, session IDs, and
prompt excerpts. `runs/` is git-ignored in this repo; the methodology and tools are the shareable
parts, the run data is not. Never commit or publish run output as-is.

## License

Apache-2.0 (see the repo root [`LICENSE`](../LICENSE)).
