# Agent Session Analysis -- Methodology (v1)

> This document describes HOW the analysis works -- a standalone, shareable spec. Project build
> state, run results, and open items live in `02-status.md`, not here.
>
> Versioning: this is METHODOLOGY v1 (selection, working-time incl. the AskUserQuestion edge,
> per-output timeline, work-type, KB artifact-class + value-lean). The implementing scripts track
> their changelog through this repo's git history; when the method itself changes, bump the
> methodology version here so older runs stay interpretable against the spec that produced them.

## Purpose

Measure, from Claude Code session transcripts, **what an agent actually spends its time doing** --
a repeatable analysis, re-runnable to spot trends over time. The unit of study is the agent's
**working time** -- the time from a human prompt until the agent stops and hands control back
(defined precisely in "Agent working time vs ignored time" below) -- and how it decomposes: what
kinds of work, what outputs, what tokens, and -- as ONE dimension within that broader picture --
how the knowledge base (KB) is referenced and maintained.

Scope note: this started as "KB usage over time" and broadened. KB usage is no longer the subject;
it is one lens. The subject is the full shape of agent effort -- work-type, per-output timeline,
token spend, and KB interaction together. KB analysis remains a first-class part (it is where a lot
of the interesting continuity/re-work signal lives) but it sits inside the larger question of where
the agent's wall-clock goes.

It separates three epistemic tiers and never lets them blur:

1. **MEASURED** -- observed directly from transcript records (timestamps, tokens, tool calls).
2. **CLASSIFIED** -- an agent's judgement against a fixed taxonomy (work-type), auditable.
3. **INDICATIVE** -- an agent's coarse value-lean (KB artifact-class value), explicitly NOT a hard value.

The cardinal rule: a number's tier travels with it everywhere. A MEASURED number may be summed and
trended. An INDICATIVE number may only be ranked/compared, never summed or reported as fact.

### Analysis dimensions (the broader picture)

Each session is characterized along these, agent working-time being the spine the rest decompose
(working-time is defined precisely in "Agent working time vs ignored time" below):

1. **Agent working-time** -- the spine. How much working time the turn(s) consumed. MEASURED.
2. **Per-output timeline** -- where that time went, output by output. MEASURED.
3. **Token spend** -- reported as three buckets, per output and per session: **Input Tokens Used**
   (= input + cache_creation, all input-side tokens newly processed this run), **Output Tokens Used**
   (generated tokens, a separate API billing line), and **Cache-read Input Tokens** (input served
   from cache). Input and output are kept separate because they bill separately. MEASURED.
4. **Work-type** -- what kind of work the time bought. CLASSIFIED.
5. **KB interaction** (files under KB_ROOT) -- referenced / updated / went-back / gaps, plus
   artifact-class + value-lean. MEASURED (interaction counts) + INDICATIVE (class value-lean).
   One dimension among these, not the frame.

Future dimensions can be added here without re-architecting -- the spine (agent-time) and the
deterministic extractor stay; new lenses are new columns/agent-judgements.

---

## What counts as a session (selection)

- Source: per-session transcript JSONL files under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
- Window: an explicit **`--start`/`--end` date range** (`YYYY-MM-DD`, system LOCAL time, inclusive),
  selected by file **mtime**. The date range governs selection entirely -- there is no relative
  "last N days" and no separate today-exclusion (a past window excludes today by construction; a
  window ending today includes it). One run = one window; runs are diffable over time.
  - **mtime is the selection clock (v1) -- and it makes window edges fuzzy.** A session is attributed
    to when it was *last modified*, not when the work *happened*. A long-running or resumed session
    can have its actual activity (record timestamps) fall *outside* the window its mtime selects it
    into -- e.g. work done 2026-05-21 in a file last touched 2026-06-08 lands in a June window. For a
    single run this is harmless; for two adjacent runs it means they do **not** cleanly partition by
    real work date -- a little edge bleed is expected. The per-session `session_start_local` /
    `session_end_local` (record timestamps) expose this, and `run-meta` reports the observed span
    alongside the requested window so the gap is visible.
  - **v2 RECONSIDERATION (do later, not now):** evaluate selecting on session record-time (first/last
    real human-prompt timestamp) instead of mtime, for clean partitioning by actual work date. The
    trade-off: record-time selection requires reading into each file to decide membership (slower
    scan) and would shift existing runs' membership, so it is a versioned methodology change, not a
    quiet swap. Kept on mtime for v1 to preserve comparability with the first run.
- Substantive filter: **>= 5 REAL HUMAN prompts** (not raw `user` records -- see classifier below).
  TUNABLE run parameter (`min_human_prompts`, default 5). The purpose of the cut is to exclude
  one-shot and trivial sessions while keeping sessions where real work happened, even with little
  back-and-forth.

### Why 5 (evidence, not an arbitrary number)

Evidence basis: the 14-day window **2026-06-04 to 2026-06-17** (~5,800 top-level sessions),
examined while developing this methodology on 2026-06-17. This is a development-time SNAPSHOT, not
a standing fact -- see the re-check caveat below. In that window the human-prompt distribution is
sharply bimodal -- the dominant feature is a CLIFF between 1 and 2+:

```
1 prompt :  5,724  (98.8% -- one-shots: a question, a !command, a /skill call)
2-3      :     12
4-5      :      9
6-10     :      6
11-20    :     12
21-50    :     13
51-100   :      7
101+     :      9
```

The exact cut barely moves turn-volume (>=2 captures 34.2% of all human-turns; >=11 captures
32.8% -- the small sessions hold almost no volume). So the choice is about SUBSTANCE, not volume.
Inspecting what the 2-9 band actually DID (tool calls + writes as a substance proxy):
- **2-3 prompts: dead band.** 12 sessions, mostly /debug or local-command wrappers, 9 of 12 had
  ZERO tool calls, ZERO writes across the whole band. Trivia.
- **4-9 prompts: genuinely mixed, contains real work.** e.g. a 5-prompt session with 42 tool calls
  and 21 writes (wrote a doc to share with co-workers); a 4-prompt/7-write KB-setup session; a
  7-prompt branch+ticket session; 9-prompt /doctor-fix and ANP-ticket sessions.

Conclusion: the dead zone is 2-3; real work appears from ~4-5 up. **>=5** excludes the trivia while
keeping short-but-productive sessions. >=10 was considered but drops real 5-9 turn working sessions
(the 21-write doc session, the branch session) for no measurement benefit. >=2 readmits the dead band.

CAVEATS:
- Turn-count is a PROXY for substance, not substance itself. A 5-prompt/21-write session is more
  substantive than some 6-prompt/0-tool ones. The proxy is good enough as a cheap default but is
  imperfect. FUTURE option (not now): a substance filter (e.g. ">=5 prompts OR >=N writes") so a
  short-but-productive session is never dropped on turn-count alone.
- This threshold was set from ONE 14-day window on one machine. The 1->2 cliff is very likely
  stable (one-shots dominate any usage), but re-check the distribution as the dataset grows.

### Scope boundary: top-level sessions only (v1); sub-agents/workflows are v2

- v1 reads only TOP-LEVEL session transcripts: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
- Sub-agent and workflow-agent transcripts live deeper -- `.../<parent-uuid>/subagents/...
  /agent-*.jsonl` -- and are NOT on the v1 scan path. The selector also explicitly skips any path
  containing `/subagents/` so this stays deliberate, not accidental.
- This is a SCOPE BOUNDARY, not an exclusion-on-principle. Sub-agent/workflow work is REAL work --
  it bears on what got done when, on timing, and on KB usage. It is simply not read yet.
- **v2 NOTE (do later, not now):** extend the analysis to INCLUDE sub-agent/workflow transcripts,
  attributed to their parent session, so spawned work counts toward the picture. Verified to be
  straightforward (the transcripts exist, are well-formed, and carry the same record shape), but
  out of scope for v1. Deferred deliberately.

### Exclusion-on-principle: sessions running THIS analysis (all versions)

Distinct from the scope boundary above. A session that is itself RUNNING this measurement must be
excluded from the measured set -- it is an OBSERVER session, not a SUBJECT session, and including
it skews exactly the metrics we measure (it is heavy agent-time + tokens + KB-reads by construction;
e.g. an analysis run that spawns 50+ agents). Observer-measuring-itself contamination.

Mechanism:
1. **Self-marking sentinel.** Every analysis session emits a fixed sentinel near its start. The
   sentinel must be DISTINCT (unlikely to occur in normal work) and GENERIC (no product/personal
   names -- this component is public and vendor-neutral). Default:
   `AGENT-SESSION-ANALYSIS-RUN::observer` (a deliberately unusual literal). The selector drops any
   top-level transcript containing it. No UUID list to maintain. CRITICAL: the sentinel must be
   emitted by the RUN TOOLING itself (the fanout driver / run procedure), not rely on a human or
   agent remembering to type it -- the act of running an analysis self-marks the session. The exact
   string is a config constant so it can be changed without touching logic.
2. **Backstop.** The selector also flags (for confirmation, not silent drop) any top-level
   transcript that heavily references the analysis tooling paths (`agent-session-analysis/`,
   `extract-session-metrics`) -- catches a session that somehow missed the sentinel.

How it works in practice (no timing gap): the sentinel is written near the START of an analysis
session, so it is in that transcript before any LATER run reads it. An analysis never reads its own
in-progress transcript -- it reads the prior window -- so "exclude my own session" is never asked
of the run that is writing it. Both passes exclude cleanly on the sentinel: the mechanical script
greps for it and skips the file; each workflow agent sees it on open and early-exits. The only
requirement is that the sentinel land early enough to be present in the file -- which the
run-tooling-emits-it rule guarantees.

Mixed sessions (part real work, part analysis) are a judgement call: exclude if analysis dominated,
flag if minor.

NOTE on agent-system-build sessions: sessions where the user builds/debugs the agent's own
harness/infrastructure are NOT excluded -- they are real agent work, classified as work-type
`agent-system-build`. Only sessions running THIS measurement are excluded. Building the system !=
measuring the system.

---

## Human prompt vs tool-result (THE load-bearing classifier)

Every turn boundary depends on this, so it is structural, not heuristic:

- A `user` record is a **TOOL RESULT** (agent-internal, NOT a turn boundary) if:
  - it has a `toolUseResult` key, OR
  - its `message.content` is a list containing a `tool_result` block.
- Otherwise it is a **REAL HUMAN PROMPT** (a turn boundary): `content` is a string, or a list with
  `text` and no `tool_result`.

Validated against real transcripts: in one session, 62 `user` records = 15 human + 47 tool-results,
cleanly separated by this rule.

---

## Agent working time vs ignored time -- MEASURED

This is the spine metric. Below, "Gap A" and "Gap B" are local shorthand used ONLY within this
section and its AskUserQuestion subsection -- they are not used as standalone terms elsewhere in
the doc. The boundary is BEHAVIORAL -- "did control return to the human":

```
[human prompt] ---- Gap A (agent owns the turn) ----> [agent's last msg before next human prompt] ---- Gap B (human reading/deciding/away) ----> [next human prompt]
```

- **Gap A = agent wall-clock = MEASURED.** From a human prompt to the agent's last message before
  the next human prompt. **Everything inside counts**: inference, tool round-trips, builds,
  sub-agents/workflows, background-task waits -- AND even the human multitasking elsewhere, as long
  as the agent's turn has not yet returned control. If the turn hasn't handed back, the clock runs.
- **Gap B = ignored.** Agent handed control back -> human's next prompt. The human's think/read/away
  time. Dropped entirely.

What this metric IS: **machine effort / agent busy-time.** What it is NOT: time-saved, and NOT
human-equivalent time. Different axis. Never conflate. (The old "60-160 hours saved" figure was
retracted precisely because it was counterfactual-human-minutes, not this.)

Honest caveat kept in the open: Gap A counts build/sub-agent waiting as agent time -- it is
"time the task occupied," which is correct, but it is "spent" not necessarily "well-spent."

### The AskUserQuestion edge (part of v1)

A turn ends when the agent **stops outputting and awaits input** -- behavioral, not lexical:
- An **AskUserQuestion modal** DEFINITIVELY ends the turn (forces stop-and-wait).
- An **inline "?"** does NOT end a turn (the agent often asks and charges ahead).
- => The measurement never reads question text; it keys on where the agent actually stopped.

PROBLEM (verified in data): the answer to an AskUserQuestion modal is logged as a `tool_result`
with `toolUseResult: true` -- structurally identical to a Bash/Read result. So the naive classifier
treats the human's decision time as Gap A. Unlike a normal stop-and-wait, the agent does NOT return
control to the human after a modal answer -- it RESUMES in the same turn. So the decide-time lands
buried INSIDE Gap A and the base algorithm cannot see it. Confirmed example: modal asked 21:06:02,
answered 21:07:58 -- the base algorithm counted that turn as 200.9s when the true agent work was
84.7s; **116.2s of human decide-time wrongly counted as agent work (58% inflation on that turn).**

### Two timestamps make this an EXACT cut (not a heuristic)

The AskUserQuestion `tool_use` record and its answering `tool_result` record EACH carry their own
record-level timestamp. Between them is nothing but a ~40ms system attachment. So:
```
[agent work ...] -> [AskUserQuestion tool_use @ T_ask] ...... human deciding ...... [tool_result @ T_answer] -> [agent resumes ...]
                                                   T_answer - T_ask = pure human decide-time
```
- Everything **up to T_ask** = agent work (counts).
- **T_ask -> T_answer** = human decide-time (EXCLUDE). The exact interval, by subtraction.
- Everything **after T_answer** = agent resumes (counts).

This is a two-field subtraction, not a fuzzy span. It is also MORE correct than any cap/heuristic:
verified on a real Chat-About-This where the human stepped away for 8,545s (2.4 hr) -- the cut
excludes all of it correctly; a fixed cap would have wrongly kept some.

### Case analysis -- the cut is path-agnostic (verified across 59 instances)

All three response paths have IDENTICAL record shape (`tool_use -> tool_result -> agent resumes`);
only the tool_result CONTENT differs. So the same T_ask->T_answer subtraction handles all of them:

| Path | tool_result content | needs the cut? |
|------|---------------------|----------------|
| Pick an option (40 sampled) | "Your questions have been answered: ..." | YES -- decide-time is inside the turn, agent resumes after |
| Type "Other" / Chat About This / reject (19 sampled) | "The user doesn't want to proceed ..." | covered by the SAME cut; here the agent typically outputs once and THEN a real human turn follows, so most of the wait is already Gap B -- but the cut still correctly removes the short modal-interaction slice |

Why "Chat About This" needs nothing special, yet the cut is still safe: in that path control
DOES return to the human as a normal human-prompt turn, so the long wait already lands in Gap B
(excluded by the base algorithm). The T_ask->T_answer slice there is just the brief menu
interaction. Removing it is harmless and keeps one uniform rule. The path where the cut is
LOAD-BEARING is "pick an option," where the agent resumes in-turn and the decide-time would
otherwise be buried in Gap A.

### FIX (v1, two layers)
1. Deterministic: for each `tool_use` with `name == "AskUserQuestion"`, subtract
   `(T_answer - T_ask)` from that turn's Gap A, where T_answer is the matching `tool_result`
   timestamp. STRICTLY AskUserQuestion-only -- never applied to ordinary tool calls (Bash/Read/etc.),
   whose result gap IS agent work.
2. Agent backstop: the reading agent, building the per-output timeline, confirms/corrects the
   exclusion with full context (catches future modal variants the name-match misses).

---

## Per-output timeline -- MEASURED

Every assistant record carries its own timestamp AND its own `message.usage`. So per session we
reconstruct an ordered timeline, one row per output:

| field | source | tier |
|-------|--------|------|
| ts | record timestamp | MEASURED |
| type | text / tool_use / thinking | MEASURED |
| delta_sec | ts - previous output ts | MEASURED |
| tokens (in/out/cache_read/cache_creation) | message.usage | MEASURED |
| tool | tool_use.name if any | MEASURED |
| kb_artifact | KB path if the tool touched a file UNDER `KB_ROOT` | MEASURED |
| thinking_present | thinking block present | MEASURED |

`thinking` blocks are captured when present. Tool result *contents* (`toolUseResult.stdout` etc.)
are available, so we can see what a KB Read actually returned and time the surrounding work.

### KB_ROOT -- what counts as KB usage (configurable)

`KB_ROOT` is a configurable input: **where the knowledge-base projects live** (default
`~/ClaudeDesktop`). It is the single definition of "is this KB usage":

> **What "KB" means here.** `KB_ROOT` is the **parent directory** that holds all your individual
> project knowledge bases -- one subdirectory per project, each based on the `project-knowledgebase`
> template (the sibling component in this repo). The artifact-class ruleset below keys on that
> template's structure (`00-project-brief.md`, `02-status.md`, `03-decisions.md`, `04-backlog.md`,
> `DOCUMENT-MAP.md`, `plans/`, `reference/`, `scratch/`, ...), so classification is most accurate
> when the project dirs under `KB_ROOT` follow that layout. Project dirs that don't are still counted
> as KB interaction; their files just fall through to the `other` class.

- A tool call is **KB interaction** ONLY if its target path is UNDER `KB_ROOT`. This applies to BOTH
  the MEASURED interaction counts (kb_read_count / kb_write_count) AND the INDICATIVE classification
  below -- "KB" means ONE thing throughout: files under `KB_ROOT`.
- Files OUTSIDE `KB_ROOT` -- agent-memory/ISA (`MEMORY/WORK/*/ISA.md`), identity/config
  (`USER/`, `CLAUDE.md`), source repos, `/tmp`, etc. -- are **NOT KB usage** and do not count toward
  any KB metric. They still appear in the per-output timeline as ordinary tool calls (part of the
  general "what was the agent doing" picture) -- they are simply not KB interaction.
- Rationale: ISA/MEMORY/config accesses are a different kind of thing; folding them into "KB" would
  make the KB numbers mean two scopes at once. If agent-memory usage is ever worth measuring, it
  becomes its OWN dimension later, not a muddying of this one.

The scripts and run config take `KB_ROOT` as a parameter (default `~/ClaudeDesktop`); nothing
hardcodes the literal path.

---

## Work-type classification -- CLASSIFIED (agent judgement, auditable)

One agent per session reads the transcript and assigns work-type(s) from a FIXED taxonomy of 13.
The taxonomy is closed: a session that fits nothing else is `meta-other`, never a new label. Each
type is defined by what the session's *primary product* is, not by which tools were used -- a session
full of `Edit` calls is `code-implement` only if the edits target code; the same tool editing a spec
is `planning-spec`. When two types both seem to fit, the **boundary note** says which wins.

| Work-type | Definition (primary product of the session) | Boundary note -- how it differs from its neighbours |
|-----------|---------------------------------------------|------------------------------------------------------|
| `code-implement` | Writing or modifying source code in an *external* codebase to add/change behaviour. | vs `agent-system-build`: whose system -- external project vs the agent's own harness. vs `debug`: building new behaviour vs diagnosing broken behaviour. |
| `code-review` | Reviewing existing/proposed code (a PR, a diff, a file) and producing findings or dispositions, not authoring the feature. | vs `code-implement`: judging code vs writing it. Materialising review notes into a file is still review. |
| `debug` | Diagnosing why something already-built misbehaves; reproducing, isolating, and fixing a specific failure. | vs `code-implement`: the goal is "make the broken thing work", not "add a new thing". A fix that is mostly new code can still be `debug` if diagnosis dominated. |
| `research` | Investigating an open question -- reading docs, running experiments, comparing options -- to *learn*, with findings as the product. | vs `learning-qa`: research is multi-step investigation with a durable finding; learning-qa is a quick answered question. vs `architecture-design`: research informs a decision; design commits to a structure. |
| `architecture-design` | Designing the structure of a system/feature -- components, interfaces, trade-offs -- before/without building it. | vs `planning-spec`: design decides *shape* (how it fits together); planning-spec decides *scope and sequence* (what, in what order). Often co-occur; pick the dominant one as primary. |
| `planning-spec` | Producing a plan, spec, requirements, roadmap, or tracker that defines scope and sequence of work. | vs `docs-writing`: a spec is forward-looking (what *will* be done); docs describe what *is*. vs `architecture-design`: scope/sequence vs structure. |
| `docs-writing` | Authoring durable explanatory documentation -- guides, READMEs, reference material -- describing existing things. | vs `planning-spec`: descriptive vs prescriptive. vs `kb-maintenance`: writing *content* vs reorganising/curating the KB structure. |
| `infra-ops-config` | General system/ops/infra work: packages, services, networking, storage, deployment, machine config. | vs `agent-system-build`: general infra vs specifically the *agent's own* harness. vs `code-implement`: configuring systems vs writing application code. |
| `data-analysis` | Querying, transforming, or analysing data to produce a result, table, or finding. | vs `research`: structured data work vs open-ended investigation. The product is an answer derived from data, not learned from sources. |
| `agent-system-build` | Work on the *agent's own* harness / infrastructure / config -- skills, hooks, the Algorithm, agent tooling, MCP wiring, steering rules. The self-referential category. | vs `code-implement`: the agent's own system vs an external project. vs `infra-ops-config`: the AI agent's harness specifically vs general ops. Generic name for what a PAI user calls PAI-self-build. Real work; classified, not excluded. |
| `learning-qa` | A question asked and answered -- the human learns something, no durable artifact built. | vs `research`: a quick lookup/explanation vs a multi-step investigation with findings. Usually short, few tool calls. |
| `kb-maintenance` | Curating the knowledge base itself: reorganising, indexing, linking, updating stale docs, structural upkeep. | vs `docs-writing`: tending the KB's structure/freshness vs authoring new content. vs `planning-spec`: housekeeping vs defining work. |
| `meta-other` | Anything that genuinely fits none of the above. The closed-taxonomy escape hatch. | Use sparingly -- if you reach for it twice in a run, check whether an existing type actually fits. |

Returns: `primary_type`, `secondary_types[]`, `justification` (one line), `confidence`.
Multi-label allowed; one primary. The justification makes it auditable, not a black box -- when a
session straddles two types, the justification should name which boundary note decided the primary.

---

## KB artifact-class + value-lean -- INDICATIVE (v1 approach)

For v1 we do NOT attempt a per-fetch counterfactual judgement (that is rich but error-prone; see
the v2 note). Instead we classify each in-`KB_ROOT` reference by its STRUCTURAL LOCATION in the
project-KB layout, and attach a coarse value-LEAN per class. The class is mostly deterministic
(the path tells you the role); the value-lean is an INDICATIVE default the agent may override.

### Class ruleset (case-insensitive; applied ONLY to paths under KB_ROOT; first match wins)

| Class | Match (relative to KB_ROOT, case-insensitive) | Value lean |
|-------|-----------------------------------------------|------------|
| backlog | `*backlog*` (e.g. `04-backlog.md`) | `medium` |
| decisions | `*decision*` (incl. `03-decisions.md`) | `high` |
| plan/spec/tracker | `plans/`, `*spec*` (wildcard both sides), `*tracker*`, `roadmap`, `project-brief`, `*-brief`, `*-status` (incl. top-level `00-project-brief.md`, `02-status.md`) | `high` |
| reference | `reference/`, `*-ref*` | `med-high` |
| scratch/ephemeral | `scratch/`, `journal/`, `handoff`, `reviews/` | `low` |
| output | `output/` | `low-med` |
| index/nav | `DOCUMENT-MAP` (exact-ish; NOT a loose `index` substring -- that false-matches project names like `indexed-kb`) | `low-enabling` (low intrinsic, high enabling) |
| other | under KB_ROOT, matches none above | `unclassified` (agent confirms) |

Top-level KB files split by ROLE, not lumped (the pilot's override pattern earned this):
- `00-project-brief.md` (the orient-me anchor) and `02-status.md` (resume-from-state) -> plan/spec/tracker, `high`. Their counterfactual is re-orienting / re-investigating project state -- continuity-breaking.
- `03-decisions.md` -> decisions, `high`. Counterfactual is re-litigating settled reasoning -- the most expensive re-work.
- `04-backlog.md` -> backlog, `medium` (NOT high). It is a parking lot of unprioritized ideas; losing it breaks nothing active and is cheap to regen. An agent MAY override upward if a backlog item turned out load-bearing in that session.

(Value-lean tokens are the exact machine enum: `very-low / low / low-med / medium / med-high / high
/ very-high`, plus `low-enabling` and `unclassified`. Prose and code use the SAME tokens so the
schema, the deterministic script, and this table never drift.)

Precedence is the table order (a path matching several lands in the first). ORDER MATTERS: `backlog`
and `decisions` come BEFORE `plan/spec/tracker` so `04-backlog.md` is not swept into the high tier
and `03-decisions.md` lands in decisions. The order is fixed and documented for determinism.

### Value-lean discipline (INDICATIVE)

- The value-lean (very-low / low / medium / high / very-high) is a coarse DEFAULT per class -- a
  stated heuristic from the KB's own structure, NOT a per-fetch measurement.
- It is INDICATIVE: rank/compare only, NEVER sum, NEVER trend as if real, NEVER quote as "X hours
  saved." A `plans/` fetch LEANS high-value; a `scratch/` fetch LEANS low.
- The structural class is a PROXY for value, not value. A `scratch/` file can occasionally hold
  something load-bearing; a `plans/` doc can be stale. The agent MAY override the class default
  when actual usage contradicts it, with a one-line note + confidence -- but the default comes free
  from the path.

Why keep it: it enables RANKING and pattern-finding ("resume sessions disproportionately pull
plan/spec/tracker artifacts") without pretending to a hard number.

### v2 NOTE (deferred -- not tonight): per-fetch counterfactual value taxonomy

A richer value model was designed and is deliberately deferred. It would score each KB fetch by the
CHEAPEST ALTERNATIVE the agent would otherwise have fallen back to, along TWO axes (time-saved AND
error/hallucination-risk-averted), at two scopes:
- per-fetch counterfactual source: re-derive/re-decide (internal) vs infer-from-training
  (cheap but hallucination-prone -- KB value here is CORRECTNESS/trust, not time) vs re-research
  externally (man pages / --help / web / code-reading -- KB value is TIME + determinism) vs
  regenerate the whole artifact.
- per-fetch scope: whole-artifact regen vs just-the-piece-needed (the ratio = lookup-index vs
  deep-context-substitute).
- session-structural: resume-from-living-state (a maintained spec/tracker/status lets a session
  resume WITHOUT building/reading a bespoke handoff doc each session boundary -- recurring overhead
  the KB structure eliminates).
v1 ships the structural class + value-lean above as a FEASIBILITY PROBE; if the agent can tag class
reliably on real data, the richer two-axis taxonomy becomes v2.

---

## Division of labor (keeps re-runs cheap and reproducible)

- **Deterministic script (`extract-session-metrics.py`):** selection, human/tool classification,
  agent working-time (incl. AskUserQuestion exclusion), per-output timeline, tokens, KB refs,
  rollups. ZERO agent tokens. Re-runnable identically. This is the MEASURED tier in full.
- **Agent fanout (one per session):** work-type (CLASSIFIED) + KB artifact-class value-lean (INDICATIVE) +
  ignored-time backstop (the AskUserQuestion exclusion, see working-time section). The only
  token-spending layer; only it needs re-running when judgement is wanted.

---

## Outputs / run layout

```
agent-session-analysis/
  README.md                        component overview (for the ai-tools root table)
  RUNBOOK.md                       the ordered how-to-run procedure
  METHODOLOGY.md                   this file
  Tools/
    extract-session-metrics.py     deterministic metrics: selection, working-time, tokens, KB refs,
                                   per-output timeline, temporal (day/hour + overlap), run-meta emit.
    classify-and-estimate.workflow.js  fanout driver: work-type (CLASSIFIED) + KB class
                                   value-lean (INDICATIVE) + AskUserQuestion backstop.
  runs/                            <-- the --out PARENT dir (run data is local-only, not committed;
                                       transcripts carry real paths, names, and prompt excerpts)
    <START>_<END>[_N]/             <-- per-run subdir, AUTO-CREATED from the window; _N on collision
                                       so a re-run NEVER clobbers an existing run.
      metrics.json                 deterministic per-session output + aggregate
      temporal.json                day-of-week + hour-of-day histograms (human-prompt ts, local tz)
                                   + concurrent/overlapping-session pairs. FULL per-bucket data.
      run-meta.json                mechanical run record: script version, window (requested +
                                   observed span), KB_ROOT, threshold, totals, skip breakdown,
                                   temporal SUMMARY stats, scanned-file list. Provenance + comparability.
      run-meta.md                  human-glanceable render of run-meta.json (X time, Y agent-time,
                                   N turns, busiest day/hour, file list).
      judgements.json              fanout output (work-type + KB class value-lean), joined by path
      report.md                    the run's writeup -- tiers kept separate, with tentative
                                   conclusions. (Was "synthesis.md"; renamed -- this is iterating
                                   toward an actionable run-report.)
```

Each run's dir name encodes its window so results are diffable over time -- the whole point of
materializing this. `run-meta` is emitted mechanically by the deterministic pass (every number in it
already exists in the metrics), so it can never drift from the data and needs no hand-maintenance.

---

## Report generation -- `report.md` (WORK IN PROGRESS -- v1 starting point)

This is the *current* method for writing a run's `report.md`. It is deliberately materialized now,
early and imperfect, so every run follows the same recipe instead of being improvised -- and so the
recipe itself becomes a thing we iterate on. **The report is the only hand-AUTHORED artifact in a
run** (metrics, temporal, run-meta, judgements are all generated). It is written by the primary agent
from the joined data; it is NOT produced by the fanout. Today there is no separate "report agent" --
adding one (or a cross-vendor review pass on the report) is a candidate refinement, not v1.

### Inputs (read all of these before writing)

1. `metrics.json` -- MEASURED per-session + aggregate.
2. `judgements.json` -- CLASSIFIED work-type + INDICATIVE value-leans, joined to metrics by `path`.
3. `temporal.json` -- day/hour histograms + overlap.
4. `run-meta.json` -- window, observed span, skip breakdown (so the report's header matches reality).

Join judgements to metrics by `path` first; the report is written from the joined view, never from
one layer alone.

### The non-negotiable discipline: three epistemic tiers stay separate

The report's spine is the same three-tier separation the whole methodology rests on. **Never collapse
them into a single "value" or "score."** Every section is labelled with its tier so the reader always
knows what kind of claim they are reading:

- **MEASURED** -- deterministic, summable. State sums and trust them.
- **CLASSIFIED** -- agent judgment against the fixed taxonomy. Count sessions; do NOT sum as value.
  Measured quantities (time, KB counts) MAY be grouped *by* a classified bucket -- the number is
  measured, the bucket label is the judgment; say so explicitly.
- **INDICATIVE** -- coarse KB value-lean. Rank only. NEVER sum, NEVER average into a score.

### Required section skeleton (in order)

1. **Header** -- one paragraph: run window (requested + observed span if they differ), session count,
   selection threshold, KB_ROOT, selection-clock caveat (mtime) when relevant. Pull straight from
   `run-meta` so it cannot drift.
2. **Tier legend** -- the three-tier "read the tiers, not a single number" framing, verbatim in
   spirit. Anchors every downstream claim.
3. **MEASURED** -- the headline mechanical table (sessions, agent working-time, human turns, tokens,
   KB reads/writes). Tokens are three buckets: Input Tokens Used, Output Tokens Used, Cache-read
   Input Tokens. Do NOT include the selection skip breakdown (out-of-window / below-threshold /
   sentinel / subagents) in the report -- those are selection mechanics, they live in `run-meta`, and
   sentinel/subagents are structurally always zero in v1. At most, the header may note "N sessions met
   the bar" for context; the per-reason skip counts do not belong in the report. Then prose on what
   the measured numbers say -- distribution shape (is time long-tailed? name the top sessions), not
   just totals.
   **The AskUserQuestion decide-time exclusion is NOT reported in the report at all.** It is pure
   bookkeeping: it makes the agent working-time number honest (human modal decide-time is subtracted
   so it cannot inflate agent-time), but it is not a finding and has near-zero reader value. State
   agent working-time as the figure and stop. Do NOT add an AQ row to the table, do NOT explain the
   adjustment in prose, do NOT name its hours/percentage/concentration. The full accounting lives in
   the underlying-data layer (`metrics.json` per-session `askuserquestion_excluded_sec`, and
   `run-meta`) -- that is where anyone who needs it looks, not the report. (Same principle, stronger:
   do not spend report real estate on a mechanical correction.)
4. **CLASSIFIED** -- work-type table (sessions + measured time + KB counts per primary type). Prose
   headline on what the *shape* of work is. Distinguish frequency (how many sessions) from mass (where
   time/output concentrate) -- they often diverge and that divergence is usually the most interesting
   finding.
5. **INDICATIVE** -- KB-class value-lean distribution table. Prose on which classes carry weight and
   how often structural defaults were genuinely overridden (and which direction). Rank language only.
   Be precise about what "override" means: an override is a value-lean RE-RATING of a file that stays
   where it is -- nothing is moved, promoted, or copied. Count only the notes that actually changed a
   class's default; do NOT lump in (a) `other` judgments (which have no default, so they are
   judgments, not overrides) or (b) notes that confirm the default held. State the real override count
   separately from the total note count.
   **Mislocation analysis -- the temporal-value question.** A high-value file living in a low-value
   area (a spec/tracker in scratch/, a loose root file) is NOT automatically misuse. Three states, and
   the discriminator is the file's usage timespan:
   - *Bounded high-value-then-disposable* -- used heavily WITHIN one work session (even a long one)
     and not after. Scratch/output is arguably the correct home; it will be cleaned up. Not misuse.
   - *Long-but-bounded effort* -- a session that spanned days / was resumed later, still one bounded
     piece of work. Lean toward not-misuse; high-value while live.
   - *Cross-session durable* -- the same file pulled back in across multiple distinct sessions over
     time. THIS is the misfiling signal: durable state living in the wrong place. But it is a SIGNAL,
     NOT a verdict, and there can be several reasons it misleads. ONE example of a counter-signal: a
     cluster of fresh sessions over a few days resuming a large ephemeral tracker -- bounded work, not
     misfiling. That is illustrative, not the only counter-signal. Always look for whatever
     counter-evidence the specific case offers; do not conclude misuse from reuse alone.
   Data limit to state honestly: per-session span IS available (`session_start_local`/
   `session_end_local`), so single-session duration is checkable. CROSS-session reuse of the same file
   is NOT tracked by current tooling (each session is judged in isolation) -- so any cross-session
   mislocation claim is a judgment with limited evidence and a v2 data candidate, not a firm finding.
6. **TEMPORAL** (NEW) -- when the work happened (from `temporal.json`, local tz, human-prompt
   timestamps). MEASURED tier. Render as TWO tables plus prose:
   - **Day-of-week table** -- Mon..Sun, each with prompt count and share %.
   - **Hour-of-day bucketed table** -- six FIXED time-of-day blocks, each with count and share %.
     The buckets are a standing schedule (keep them constant across runs for comparability; do NOT
     reshape them because a given window happens to have empty hours -- empty buckets are real data):
     08-12 (08:00-12:59), 13-15, 16-20, 21-24/00 (21:00 through the midnight 00:00-00:59 hour),
     01-04, 05-07. They tile all 24 hours once: 08-12 owns hours 08-12, 13-15 owns 13-15, 16-20 owns
     16-20, 21-24/00 owns 21,22,23,00, 01-04 owns 01-04, 05-07 owns 05-07. ORDER both temporal tables
     chronologically -- day-of-week Mon->Sun, hour-of-day by earliest start hour first (01-04, 05-07,
     08-12, 13-15, 16-20, 21-24/00) -- never by volume.
   - **Overlap** -- a single line (sessions in an overlapping span / total; pair count). Not tabular.
   - **Prose callouts** -- the interesting bits only, per the "observations not method" rule: day
     concentration, time-of-day skew (early/late tendency), the late-night tail, lunch dips, and any
     tentative pattern + what it might mean. Do NOT re-narrate the tables.
   NO chart/sparkline in v1. The counts are prompt EVENTS, not active time -- so this section shows
   when prompts were sent, which is weak signal until the v2 "time in front of keyboard" metric
   exists (see v2 note). Keep the prose honest about that limit. Temporal is keyed on prompt-event
   timestamps, so it is robust to walk-away gaps; a session-wall-duration reading would not be.
7. **What this run does and does NOT claim** -- explicit. The "does not" list is load-bearing: name
   the counterfactuals deliberately NOT estimated (hours saved, tokens saved, effort avoided -- all
   struck as unsupportable) and that INDICATIVE leans are rank-only by design.
8. **Tentative conclusions** -- the part we are iterating toward. Allowed to be soft and clearly
   hedged. Each conclusion MUST name the tier(s) it rests on and its confidence. This is where
   "potentially actionable" lives; it is explicitly NOT firm/hard yet -- say so.
9. **Confidence statement** -- per tier: MEASURED high, CLASSIFIED med-high (single-agent judgment,
   not cross-checked), INDICATIVE low-by-design.
10. **Artifacts** -- list the run's files and what each is.

### Claim discipline (what may be asserted, and how)

- **Report observations and conclusions, NOT method exposition** -- the report says what was observed,
  what the analyst thinks, and what is concluded. It does NOT re-explain what a metric, tier, KB
  class, override, or discriminator IS -- that definitional/method content already lives in this
  methodology, and a reader who wants it goes there. Concretely: do not open a section by teaching
  "an override is a re-rating of a file that stays where it is" or "the discriminator is usage
  timespan" -- those are method. Open with what the data shows ("6 overrides, all upward; 4 were
  scratch files acting as trackers") and what it means. The ONE thing to keep that looks like method
  but is not: the per-claim HEDGE -- the tier tag, the confidence, and the "tentative because X"
  qualifier. That is part of the claim itself (the recipe requires it), so keep it attached to the
  finding. Rule of thumb: "the metric is defined as..." = cut; "what I see is... / I conclude... /
  this is tentative because..." = keep.
- **Plain, short prose -- one claim per sentence** -- write so the claim is parseable on first read.
  Do NOT stack three-plus contrasting numbers into one clause; split them into separate sentences,
  each making one point. Plain beats clever; clear-but-longer beats dense-but-short. If a sentence
  needs a "but" joining two unrelated numeric facts, it is probably two sentences.
- **Use lists for enumerations; prose for arguments** -- when the text enumerates DISCRETE items -- a
  set of overrides, named top-N sessions, separate observations/callouts, any "N things" -- render
  them as a bulleted or numbered list so each item is scannable, not buried in a sentence. A run-on
  sentence with semicolons separating list items is the tell: make it a list. Reserve flowing prose
  for a single connected ARGUMENT where the sentences build on one another (a distribution-shape
  claim, a causal explanation). Rule of thumb: if a reader would want to pick one item out of the
  group, it should be a list item. (Sections 5/INDICATIVE and 6/TEMPORAL are the usual offenders --
  the overrides enumeration and the temporal callouts.)
- **Separate classification from analysis** -- "X is the load-bearing class", "this is work-type Y"
  are acts of CLASSIFICATION: state them plainly as labels, do not dress them up as analytical
  findings or conclusions. The finding is what the label *means* for usage, and that belongs in the
  analysis prose or the conclusions, clearly separated from the label itself. (Same error as
  emphasizing a mechanical correction: do not present an act of bookkeeping/labeling as insight.)
- **Lead with the mechanism, not the symptom** -- a finding names the specific measured pattern that
  produces it, not just its consequence.
- **Distribution over averages** -- when a sum is dominated by a few sessions, say so and show the
  concentration (top-N share); a median or mean alone misleads on long-tailed data.
- **Hedge by tier** -- MEASURED claims may be stated plainly; CLASSIFIED claims carry "the classifier
  judged"; INDICATIVE claims use rank words ("tends to", "leans") and never numbers-as-value.
- **No invented counterfactuals** -- if the data cannot support it (time saved, etc.), it goes in the
  "does NOT claim" list, not the conclusions.
- **Write from THIS run's artifacts only** -- the report is generated from one run's
  metrics/judgements/temporal/run-meta. Those inputs do not encode that any other run exists, so the
  body must not. NO cross-run phrasing in the body or header: no "again", no "same as run N", no "now
  sharper", no "this is run 2". If you find yourself writing such a phrase, it is conversation
  knowledge leaking in, not something the generation step can know -- strike it.
- **Cross-run comparison (multi-run future)** -- comparison to an earlier run is allowed ONLY in a
  clearly-labeled, separate "Cross-run" section, and ONLY when the prior run's artifacts are actually
  in hand (not recalled from conversation). Even there: only MEASURED tiers are directly comparable;
  CLASSIFIED/INDICATIVE comparisons are directional and must say so. Two runs compare; they do not yet
  establish a trend. This sentence belongs in that section, never in the header.

### Known gaps in THIS method (iterate from here)

- No separate report-generation agent and no cross-vendor review of the report itself -- the report is
  the primary agent's hand-authored read of the joined data. Candidate refinement.
- "Tentative conclusions" has no enforced structure yet beyond "name tier + confidence" -- as runs
  accumulate, this should harden into a checklist of recurring questions the report must answer.
- The report is hand-authored, so it is the one artifact that CAN drift from the data -- mitigated by
  pulling the header/totals from `run-meta` rather than re-deriving them.
- **Temporal is prompt-event counts, not active time (v2).** The day/hour breakdown counts when
  prompts were sent, not when the user was actually at the keyboard, so its signal is weak. v2 adds a
  "time in front of keyboard" engagement metric (a human response within ~15 min of the last agent
  output counts toward continuous active time; a longer gap breaks the span), and only then does
  cross-run temporal comparison (fixed Y scale / window-length normalization) become worth building.
- **KB-class counts are by file path, value is by function -- they do not reconcile (v2).** A
  functional category (trackers especially) fragments across `plan/spec/tracker`, `scratch/ephemeral`,
  and `other` depending on where files are filed. The fanout detects the true function (override
  notes) but that never flows back into the path-based counts. v2: let judgement-layer reassignment
  re-attribute the counts. So today, no single class-count row is the whole of a functional category.
- **Unknown-directory classification via project DOCUMENT-MAP (v2).** The mechanical classifier only
  knows the template-standard dirs (materialized in its path rules), and the fanout agent only knows
  the fixed class set it is instructed about -- the enum plus the defaults list in the prompt, given
  as class NAMES with no definitions. So for a KB directory that is not a recognized template dir, the
  agent today can only name-guess which known class it is closest to. v2: for a dir the mechanical
  rules do not recognize, the fanout agent should read that project's DOCUMENT-MAP.md to learn the
  dir's intended purpose, then map it to the closest known class -- or `other` if nothing is close.
  Reasonable judgement calls, applied only to unknown dirs; known/template dirs stay mechanical. This
  also requires updating the fanout PROMPT to give the agent brief per-class definitions (e.g. output
  = finished/near-finished deliverable artifacts -- reports, reviews, documents), so "closest match"
  is grounded in meaning rather than the class name. (Requires the fanout to load the project
  DOCUMENT-MAP as an input.)
