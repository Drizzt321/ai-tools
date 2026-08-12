// Friction-audit fan-out for the Claude Code Workflow tool: mine distilled session
// transcripts for friction events, then adversarially verify every event with a
// stronger model. Template -- pass paths via `args`:
//
//   Workflow({ scriptPath: ".../friction-audit.workflow.v1.js",
//              args: { scratch: "/abs/path/to/workdir" } })
//
// Expects: <scratch>/distilled/batches.json produced by Tools/distill-transcripts.v1.ts
// (with ABSOLUTE file paths -- fan-out agents have unpredictable working directories).
// Writes:  <scratch>/findings/batch-N.json and batch-N.verified.json.
//
// Model choice is load-bearing (finding from the first production run): mid-tier miners
// found 38 candidate events (6 killed as false positives), while stronger verifiers added
// 53 more -- 62% of the 85 surviving events. Miners alone caught under 40% of the final
// set. Do not skip the verify stage; do not run miners without verifiers.

export const meta = {
  name: 'friction-audit',
  description: 'Mine session transcripts for friction events, then adversarially verify classifications',
  phases: [
    { title: 'Mine', detail: 'one miner per batch of distilled sessions' },
    { title: 'Verify', detail: 'adversarial verifiers, one per batch', model: 'opus' },
  ],
}

const SCRATCH = args && args.scratch
if (!SCRATCH) {
  // The args global has been observed not to reach workflow scripts reliably; fail loud
  // rather than letting agents write to "undefined/..." paths. Fallback if it recurs:
  // embed the path as a const in a copy of this script.
  throw new Error('args.scratch missing -- pass Workflow({args: {scratch: "/abs/workdir"}})')
}
const batchesRaw = await agent(
  `Read the file ${SCRATCH}/distilled/batches.json and return its exact JSON content as your structured output. Do nothing else.`,
  { label: 'load-batches', phase: 'Mine', model: 'haiku', schema: { type: 'object', properties: { batches: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, files: { type: 'array', items: { type: 'string' } }, bytes: { type: 'number' } }, required: ['id', 'files'] } } }, required: ['batches'] } }
)
const batches = batchesRaw.batches

// The taxonomy is general; if the installation being analyzed has notable standing
// config (custom rules, gating conventions), add a short neutral note about it to the
// miner prompt so rule-related causes are judged against the right baseline.
const TAXONOMY = `CAUSE TAXONOMY (pick exactly one per event; causeRationale must justify the pick over neighbors):
- agent-misbehavior: an explicit instruction or standing rule was visibly in play THIS session (stated by the user, or the agent itself acknowledged the rule) and the agent violated or ignored it. Disobedience, not incompetence.
- rule-load-failure: behavior contradicts the user's standing configuration, but the rule was plausibly buried, stale after compaction, or in DIRECT CONFLICT with the harness's own defaults (e.g. harness says "proceed autonomously" while the user's rules say "wait for explicit go-ahead"). Two rule systems fighting is this category, not misbehavior.
- usage-pattern-mismatch: the user driving the product against its intended interaction model -- e.g. repurposing a product mode as a container for something it is not designed for, or expecting behavior the product does not promise.
- harness-defect: the tooling itself failed -- permission-prompt bugs, hook errors, compaction losing state, connector/MCP flakiness. Nobody misbehaved.
- under-specified-ask: the agent guessed on genuine ambiguity and guessed wrong; the friction is rework from an ask that under-determined the outcome.
- capability-miss: no instruction violated -- the agent simply produced wrong or low-quality work (bad code, wrong analysis, unverified assertion). Competence failure, distinct from disobedience.`

const EVENT_SHAPE = `{"sessionId": str, "project": str, "approxTime": "MM-DD HH:MM", "quote": "verbatim user words or transcript line, <=300 chars", "agentBehavior": "what the agent did, <=200 chars", "cause": "<taxonomy key>", "causeRationale": "<=200 chars", "severity": 1|2|3, "confidence": "high"|"med"|"low"}`

const results = await pipeline(
  batches,
  b => agent(
    `You are a friction-mining analyst examining REAL Claude Code session transcripts belonging to the user of this installation.

Read EVERY file listed below completely (they are distilled dialogue spines, tool outputs already stripped):
${b.files.map(f => '- ' + f).join('\n')}

FORMAT LEGEND: "USER [MM-DD HH:MM]:" = the user's typed prompt (times are UTC); "USER (queued)" = queued mid-turn; "ASSISTANT:" = agent text; "  -> Tool: {...}" = tool call; "[TOOL REJECTED/INTERRUPTED]" = user declined/interrupted; "[TOOL ERROR]" = tool failure; "[COMPACTION BOUNDARY]"; "[skill payload: X]" = skill instructions loaded; "[system-reminder]" = stripped harness injection; "...[truncated N chars]" = long message capped by the distiller. Header lines carry per-session counts.

TASK: find FRICTION EVENTS -- moments where the human-agent interaction did not go smoothly. Signals: the user interrupting; rejecting tool calls; correcting the agent ("no, I said...", "you didn't...", "again?", "stop", "wait"); repeating or re-explaining an instruction already given; scolding; frustration directed AT the agent's behavior; asking why the agent did something; abandoning a thread; redoing work. ALSO compare ADJACENT sessions in the same project (files are chronological within project): a session dropped after one prompt with the next session re-asking the same thing differently = abandonment friction. Single-prompt sessions where the agent ran long and the user never returned are AMBIGUOUS -- only flag if the next session shows a retry or complaint.

DO NOT COUNT as friction: normal iterative spec refinement (requirements evolving across turns); frustration at third-party tooling (compilers, vendors) rather than at the agent; the agent asking a reasonable clarifying question; ordinary tool errors the agent recovered from without the user noticing.

${TAXONOMY}

Severity: 1 = minor annoyance; 2 = lost time or redone work; 3 = major (wrong mutations, trust damage, abandoned work).

Be evidence-strict: quotes VERBATIM from the transcript. Do not invent friction; a batch with few or zero events is a fine answer. When torn between two causes, pick one and say what would decide it in causeRationale.

WRITE your full findings to ${SCRATCH}/findings/batch-${b.id}.json (EXACTLY this absolute path) as JSON: {"batchId": ${b.id}, "sessions": [{"sessionId": str, "project": str, "prompts": int, "tone": "<=100 chars", "noFriction": bool}], "events": [${EVENT_SHAPE}, ...]}

Then return the structured summary. Your final output is data for a pipeline, not prose.`,
    { label: `mine:batch-${b.id}`, phase: 'Mine', model: 'sonnet', schema: { type: 'object', properties: { batchId: { type: 'number' }, sessionsRead: { type: 'number' }, eventsFound: { type: 'number' }, findingsPath: { type: 'string' }, topSignal: { type: 'string', description: 'one sentence: the strongest friction signal in this batch, or "none"' } }, required: ['batchId', 'sessionsRead', 'eventsFound', 'findingsPath'] } }
  ),
  (mineResult, b) => mineResult == null ? null : agent(
    `You are an adversarial verifier auditing another analyst's friction-mining of real Claude Code session transcripts. Their findings: ${SCRATCH}/findings/batch-${b.id}.json -- read it, then spot-check against the source transcripts:
${b.files.map(f => '- ' + f).join('\n')}

The analysis question: is the user's friction (a) agent disobedience, (b) the user driving the product against its intended model, or (c) something else.

${TAXONOMY}

AUDIT EVERY EVENT: (1) Is it genuinely friction, or normal iterative work mislabeled? Kill false positives. (2) Is the cause classification right? Challenge it -- especially agent-misbehavior vs rule-load-failure vs usage-pattern-mismatch, which miners tend to blur. Reclassify with rationale when wrong. (3) Is severity/confidence honest? (4) SCAN the transcripts for MISSED friction the miner skipped -- especially rejections, interrupts, and repeated instructions -- and add events for real misses (same event shape: ${EVENT_SHAPE}).

WRITE the verified set to ${SCRATCH}/findings/batch-${b.id}.verified.json (EXACTLY this absolute path): same shape as input, but each event gains {"verdict": "confirmed"|"reclassified"|"killed", "verifierNote": "<=150 chars"} and killed events STAY in the file with their verdict. Added events get {"verdict": "added-by-verifier"}.

Return the structured summary. Your final output is data for a pipeline, not prose.`,
    { label: `verify:batch-${b.id}`, phase: 'Verify', model: 'opus', schema: { type: 'object', properties: { batchId: { type: 'number' }, confirmed: { type: 'number' }, reclassified: { type: 'number' }, killed: { type: 'number' }, added: { type: 'number' }, notableDisagreement: { type: 'string', description: 'one sentence: the most significant miner-vs-verifier disagreement, or "none"' } }, required: ['batchId', 'confirmed', 'reclassified', 'killed', 'added'] } }
  )
)

const ok = results.filter(Boolean)
log(`verified ${ok.length}/${batches.length} batches`)
return { batchesTotal: batches.length, batchesVerified: ok.length, verifySummaries: ok }
