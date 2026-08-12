# Agent Friction Analysis -- Methodology (v1)

The *why* behind the pipeline. The RUNBOOK is the *how*. Scripts are versioned by filename (`*.v1.ts`); bump the version only when behavior changes after a run has used it, so historical runs stay reproducible.

## Purpose

Attribute human-agent friction, over a date window of Claude Code session transcripts, to causes -- so the user can decide what to change (their habits, their config, their tooling) on evidence instead of impression. The unit of study is the **friction event**: a moment where the interaction visibly did not go smoothly, backed by a verbatim quote.

## Selection

- Source: per-session transcript JSONL under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
- Window: file mtime within `--window-days` of the run (edges fuzzy for long-lived sessions; acceptable for a recurring practice, document per run).
- Excluded: the `subagents/` directory (delegation transcripts are not primary interaction units; friction with a delegation surfaces in the parent session), and the analysis session itself (`--exclude-session`; mandatory, or the analysis ingests its own transcript).
- Included deliberately: single-prompt sessions. Early intuition says they are low-signal; in practice abandon->retry friction (fire a prompt, dislike the result, open a fresh session and re-ask) is ONLY visible by comparing adjacent single-prompt sessions. Batching is therefore by project, chronological within project.

## Distillation

Deterministic (no model). Keeps the interaction skeleton -- user prompts, assistant text, tool-call names with input briefs, tool errors, user rejections/interrupts, queued mid-turn messages, compaction boundaries -- and drops tool outputs, hook attachments, and injected payloads (marked, so their presence is still visible). Two reasons beyond token cost: miners read the human-agent dialogue rather than drowning in tool output, and the spines double as a durable archive (raw transcripts are subject to harness retention cleanup; the spines are what future re-analysis runs on).

Caps (per message: user 4000 chars, assistant 2500, errors 400) preserve enough to judge tone and content while bounding batch size; capped messages carry a `...[truncated N chars]` marker. All spine timestamps are UTC. Interrupt/rejection/error counts are computed during distillation and carried in each spine's header as MEASURED per-session facts; interrupt markers are counted as interrupts, not as prompts.

## Mining

One mid-tier agent per ~140KB batch. The prompt fixes: the format legend, the friction-signal list (interrupts, rejections, corrections, repeated instructions, scolding, frustration at the agent, abandonment), the DO-NOT-COUNT list (iterative spec refinement, third-party-tool frustration, reasonable clarifying questions, self-recovered tool errors), the taxonomy, the severity scale, and the output contract (JSON to an ABSOLUTE path + structured summary).

Two calibrations that matter, learned in production:

- **User-specific steers change priors, not evidence rules.** E.g. if the user says their single-prompt sessions are intentional one-shots, an interrupt there is only friction with corroboration (a retry, a complaint, redone work). Record such steers in the run's README; they are part of the run's definition.
- **Frustration must be attributed.** Frustration aimed at third-party tooling (a compiler, a flaky service) is not friction with the agent; only frustration directed at the agent's own behavior counts.

## Adversarial verification

One stronger-model verifier per batch, independent of the miner, auditing every event on four axes: genuine-vs-mislabeled, cause correctness (miners blur the misbehavior / rule-load-failure / usage-mismatch boundary), severity/confidence honesty, and missed events. Killed events stay in the file with `verdict: killed` -- the audit trail is part of the output.

Why this stage is non-optional (v1 production data): mid-tier miners found 38 candidate events of which 6 were killed as false positives; stronger verifiers added 53 more that miners had missed -- 62% of the 85 surviving events, meaning miners alone caught under 40% of the final set. A single-pass mining report would have been confidently wrong about confident wrongness.

Verifier-vs-verifier disagreement (the same incident visible from two sessions' transcripts, classed differently by two independent verifiers) is DATA -- carry both readings into the report rather than silently resolving.

## Synthesis

The calling agent reads all verified events (not just summaries), then writes the report:

- Headline: events and severity split per cause. Never assert a ratio without the per-event records behind it.
- Dedup cross-session views of one incident conservatively, and say so.
- Report the POSITIVE baseline too: fraction of sessions with zero friction, clean rate of the user's dominant prompting pattern. A friction report without the denominator overstates.
- Sev-3 incidents get individual narratives.
- The user's mid-review exclusions ("drop those, they're minor") are applied to headline numbers but the events stay tagged in the data.

## Known limitations

- mtime window selection is fuzzy at the edges.
- Cause classification is judgment (CLASSIFIED tier), adversarially checked but not ground truth; the quote + session id on every event is the audit path.
- Same-family bias: if the analyzing models share a vendor with the product being analyzed, the taxonomy split around "agent's fault" is where bias would hide. A cross-vendor review of the sanitized synthesis (see `../cross-vendor-review/`) is the mitigation; sanitize to counts, definitions, and conclusions -- no transcript content.
- The analyst is not exempt: negative claims ("X does not exist") require verified evidence trails. The v1 production run's analyst asserted a false negative mid-run from silently-failing searches, then caught it against its own report. Verify the searchers before trusting the searches.
