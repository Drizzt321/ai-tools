// classify-and-estimate.workflow.js -- fanout driver for Agent Session Analysis.
// Per session: an agent reads the transcript and returns the JUDGEMENT layer only --
//   - work-type (CLASSIFIED, fixed taxonomy)
//   - KB artifact-class value-lean confirmation/override (INDICATIVE)
//   - AskUserQuestion / ignored-time backstop note (confirms the deterministic exclusion)
// Deterministic metrics (wall-clock, tokens, KB counts, classes) are computed separately by
// extract-session-metrics.py and joined by path afterward -- agents do NOT recompute them.
//
// args: { sessions: [{path, proj, users, first, kb_class_counts}], }  (pass metrics in via args)

export const meta = {
  name: 'agent-session-analysis-classify',
  description: 'Per-session work-type + KB value-lean judgement layer (fanout)',
  phases: [{ title: 'Classify', detail: 'one agent per session: work-type + KB class value-lean + AUQ backstop' }],
}

const sessions = args.sessions
const KB_ROOT = args.kb_root || '~/ClaudeDesktop'
log(`Classifying ${sessions.length} sessions (KB_ROOT=${KB_ROOT})`)

const WORK_TYPES = ['code-implement','code-review','debug','research','architecture-design',
  'planning-spec','docs-writing','infra-ops-config','data-analysis','agent-system-build',
  'learning-qa','kb-maintenance','meta-other']

const VALUE_LEANS = ['very-low','low','low-med','medium','med-high','high','very-high',
  'low-enabling','unclassified']
const KB_CLASSES = ['backlog','decisions','plan/spec/tracker','reference','scratch/ephemeral',
  'output','index/nav','other']

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['work_type_primary','work_type_secondary','work_type_justification','work_type_confidence',
             'kb_used','kb_class_value_leans','askuserquestion_backstop','overall_note'],
  properties: {
    work_type_primary: { type: 'string', enum: WORK_TYPES },
    work_type_secondary: { type: 'array', items: { type: 'string', enum: WORK_TYPES } },
    work_type_justification: { type: 'string' },
    work_type_confidence: { type: 'string', enum: ['high','med','low'] },
    kb_used: { type: 'boolean', description: 'did the session touch any file under KB_ROOT' },
    kb_class_value_leans: {
      type: 'array',
      description: 'one entry per KB class actually used; value_lean is the INDICATIVE lean, override_note if the agent disagrees with the structural default',
      items: {
        type: 'object', additionalProperties: false,
        required: ['kb_class','value_lean','override_note'],
        properties: {
          kb_class: { type: 'string', enum: KB_CLASSES },
          value_lean: { type: 'string', enum: VALUE_LEANS },
          override_note: { type: 'string', description: 'empty if using the structural default; else why it differs' },
        },
      },
    },
    askuserquestion_backstop: {
      type: 'string',
      description: 'note if any AskUserQuestion modal decide-time appears to be miscounted, or "none observed"',
    },
    overall_note: { type: 'string', description: 'one-line characterization of what this session was' },
  },
}

const results = await pipeline(
  sessions,
  async (s, _orig, i) => {
    const big = (s.sizeKB || 0) > 4000
    const readInstr = big
      ? `LARGE transcript (~${s.sizeKB}KB). Read the opening, then sample multiple windows across middle and end; do not ingest all of it.`
      : `Read the transcript (${s.sizeKB || '?'}KB).`
    const detClasses = s.kb_class_counts && Object.keys(s.kb_class_counts).length
      ? `Deterministic pass already found these in-KB_ROOT classes used: ${JSON.stringify(s.kb_class_counts)}.`
      : `Deterministic pass found NO in-KB_ROOT tool calls (kb_used is likely false unless you see KB file work it missed).`
    const prompt = `You are doing the JUDGEMENT layer of an agent-session analysis. Use NATIVE mode for any narration; your FINAL output MUST be the structured object (StructuredOutput tool).

TRANSCRIPT: ${s.path}
PROJECT: ${s.proj}  HUMAN_PROMPTS: ${s.users}
FIRST PROMPT: ${s.first}
KB_ROOT (what counts as KB): ${KB_ROOT}  -- files OUTSIDE this root are NOT KB usage (they are ordinary tool calls).
${detClasses}

${readInstr}
Records are JSONL: type user/assistant, message.content with text/tool_use/tool_result blocks.

DO NOT recompute metrics (wall-clock/tokens/counts are already measured). Judge ONLY:

1. WORK-TYPE (CLASSIFIED): pick ONE primary + any secondary from this FIXED list:
   ${WORK_TYPES.join(', ')}
   (agent-system-build = work on the agent's own harness/infra/config.) Give a one-line justification + confidence.

2. KB CLASS VALUE-LEAN (INDICATIVE): for each KB class actually used (under KB_ROOT only), give its
   value_lean. Structural DEFAULTS: plan/spec/tracker=high (incl. top-level 00-project-brief/
   02-status), decisions=high (03-decisions), backlog=medium (04-backlog -- parking lot, not
   load-bearing), reference=med-high, scratch/ephemeral=low, output=low-med, index/nav=low-enabling,
   other=judge it.
   Use the default UNLESS actual usage contradicts it -- if so, set value_lean to your judgement and
   explain in override_note (else override_note=""). If kb_used is false, return an empty array.

3. ASKUSERQUESTION BACKSTOP: if you notice AskUserQuestion modal decide-time that looks like it
   would be miscounted as agent work (or any modal-variant the deterministic pass might miss), note
   it; else "none observed".

4. overall_note: one line on what this session actually was.

Return the schema object.`
    try {
      return await agent(prompt, { label: `cls:${i}:${(s.proj||'').slice(0,14)}`, phase: 'Classify', schema: SCHEMA })
        .then(r => ({ ...r, path: s.path, proj: s.proj }))
    } catch (e) {
      return { path: s.path, proj: s.proj, error: String(e) }
    }
  }
)

// keep only successful judgements; collect errors separately so they don't pollute the join
const all = results.filter(Boolean)
const ok = all.filter(r => !r.error)
const errors = all.filter(r => r.error)
log(`Classified ${ok.length}/${sessions.length} (${errors.length} errored)`)
return { count: ok.length, sessions: ok, errors }
