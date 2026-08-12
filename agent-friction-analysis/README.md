# agent-friction-analysis

Answer, from a window of Claude Code session transcripts, **where human-agent friction actually comes from** -- with every claim traceable to a verbatim transcript quote. The motivating question is usually some form of: "is my friction the agent misbehaving, me using the product against its intended model, or something else?" -- and the honest answer requires a cause taxonomy, adversarial verification, and evidence discipline, not vibes.

Sibling component to [`agent-session-analysis`](../agent-session-analysis/) (where the agent's *time* goes); this one is where the *friction* comes from. Same house discipline: measured facts and judged classifications are kept strictly separate, and run data never leaves the machine.

## Pipeline

1. **Distill** (deterministic, `Tools/distill-transcripts.v1.ts`): transcripts -> "dialogue spines" -- user prompts, assistant text, tool names, errors/rejections/interrupts, compaction markers. ~5% of raw size. Sessions batched by project, chronological, so miners can spot abandon->retry across adjacent sessions.
2. **Mine** (agent fan-out, `Workflows/friction-audit.workflow.v1.js`): one mid-tier agent per batch extracts candidate friction events with verbatim quotes, classified against a fixed six-cause taxonomy.
3. **Adversarially verify** (stronger-model fan-out, same workflow): an independent verifier per batch kills false positives, challenges every cause classification, and scans for events the miner missed. **This stage is load-bearing**: in the first production run, miners found 38 candidate events (6 killed as false positives) while verifiers added 53 more -- 62% of the 85 surviving events. Miners alone caught under 40% of the final set. Do not run miners without verifiers.
4. **Synthesize** (the calling agent): aggregate verified events, dedupe cross-session views of the same incident, and write the attribution report -- counts and severity per cause, with quotes.

## The cause taxonomy

| Cause | Meaning |
|---|---|
| agent-misbehavior | An instruction/rule was visibly in play and the agent violated it. Disobedience. |
| rule-load-failure | Behavior contradicts the user's standing config, but the rule was buried, stale, or in direct conflict with the harness's own defaults. Two rule systems fighting. |
| usage-pattern-mismatch | The user driving the product against its intended interaction model. |
| harness-defect | The tooling failed. Nobody misbehaved. |
| under-specified-ask | Genuine ambiguity, resolved wrong by guessing. |
| capability-miss | No rule violated; the agent was simply wrong or sloppy. Incompetence, not disobedience. |

The misbehavior / rule-load-failure / capability-miss split is the analytical heart: "the agent did something wrong" conflates disobedience (rare, in our data) with confident wrongness (common), and remedies differ completely -- enforcement hooks vs verification habits.

Severity: 1 = minor annoyance; 2 = lost time / redone work; 3 = major (wrong mutations, trust damage).

## Epistemic tiers

- **MEASURED**: interrupt/rejection/tool-error/compaction counts, session and prompt counts -- from the deterministic distiller, re-runnable.
- **CLASSIFIED**: friction events, causes, severities -- agent judgment against the fixed taxonomy, adversarially double-checked, every event carrying its verbatim quote + session id so any classification can be audited.

A ratio asserted without per-event backing is a methodology violation.

## How to run

See [`RUNBOOK.md`](./RUNBOOK.md). [`METHODOLOGY.md`](./METHODOLOGY.md) is the why: selection and exclusion rules, mining prompt design, verification design, dedup, and the lessons that shaped them.

## Privacy

Run data (distilled spines, findings, events, reports) contains real prompt excerpts and repo names. It stays local, always. This directory ships a `.gitignore` for the common run-output patterns as a second line of defense, but the actual rule is: run output goes in a separate private tree, never inside this repo's working copy.

## Requirements

- [bun](https://bun.sh) for the distiller (no external deps).
- `jq` for the flatten step in the RUNBOOK.
- A Claude Code installation whose Workflow tool (or equivalent fan-out) runs the mining/verification; the workflow file is written for Claude Code's Workflow scripting surface.

## Files

| File | What it is |
|---|---|
| `Tools/distill-transcripts.v1.ts` | Deterministic distiller: transcripts -> spines + `index.json` + `batches.json` |
| `Workflows/friction-audit.workflow.v1.js` | Claude Code Workflow fan-out: miners, then adversarial verifiers |
| `METHODOLOGY.md` / `RUNBOOK.md` | The why / the how |

## License

Apache-2.0 (see the repo root [LICENSE](../LICENSE)).
