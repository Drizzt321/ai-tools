---
name: CrossVendorReview
description: Get a second opinion on a plan, a test spec, or a code change from a model of a different vendor than the one that produced the work (supported vendors: Gemini and Mistral; no built-in default -- the caller names one or sets CROSS_VENDOR_REVIEW_VENDOR), dispatched as a background CLI call -- the reviewing cognition is the other vendor's, never the calling agent's. Modes: plan review, test-spec review (a test specification / coverage matrix against its source spec), and code review (a diff against the criteria it was meant to satisfy). USE WHEN cross-vendor review, second opinion, vendor review, get a Gemini opinion, get a Mistral opinion, review this plan/test-spec/diff with another model, non-Anthropic review, outside review, plan review before building, test-spec coverage review, code review after ship.
effort: medium
---

# CrossVendorReview

Get a plan or a code change reviewed by a model from a **different vendor than the one that produced the work**, dispatched as a CLI call to a vendor (via `dispatch.ts <vendor>`; the vendor is resolved per "Choosing the vendor" below -- there is no built-in default). This is **instructions to the calling agent**, not a persona -- there is no reviewing "character." The agent packages the payload, dispatches the call, collects the typed JSON, and reshapes it into a report block. **The review IS the provider's returned JSON. No same-vendor cognition reviews the subject.**

The value is vendor diversity: a reviewer from the same model family as whoever produced the work shares that family's blind spots. A review from a different vendor catches what a same-family reviewer would miss. When the work was produced by an Anthropic model (e.g. the Claude agent running this skill), that means a non-Anthropic vendor; work produced by another vendor's model may be reviewed by any vendor except that one, Anthropic included.

> This skill is written in the [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) format. If you are not running a skill-aware harness, treat this file as a prompt/playbook: hand it (and the chosen rubric) to your agent, or wire the provider CLI invocation below into a slash command of your own.

## Locating the toolset

Before anything else, resolve where the `vendor-clients/` toolset lives. Call the result
`<vendor-clients>` wherever this doc uses that placeholder:

1. If the `VENDOR_CLIENTS_HOME` environment variable is set, use its value.
2. Else, if `../vendor-clients/dispatch.ts` exists relative to this skill (the case when the whole
   `ai-tools` repo is checked out as-is), use that `../vendor-clients` directory.
3. Else, **stop and tell the user**: "Cannot locate vendor-clients/. Set VENDOR_CLIENTS_HOME to the
   path of the vendor-clients directory." Do not guess.

Once resolved, **`<vendor-clients>/USAGE.md` is the authoritative guide to invoking the toolset** --
the `dispatch.ts` entry point, vendor discovery, the common flag set, the output contract and exit
codes, and the two reactive `setup-required` cases (missing deps / credentials). Read it for anything
about calling a provider. This skill covers only what is specific to *reviewing*; it does NOT itself
need any API key (the chosen provider's client does, and reports precisely what it needs).

## Choosing the vendor (and model)

The toolset has no default vendor; this skill resolves one, in this order:

1. **The caller names it** (and optionally a model) -- use that.
2. **Else `CROSS_VENDOR_REVIEW_VENDOR`** is set -- use it. If `CROSS_VENDOR_REVIEW_MODEL` is also set, pass it as `--model`; it applies only when the resolved vendor IS `CROSS_VENDOR_REVIEW_VENDOR` (model names are vendor-specific).
3. **Else ask the user** which vendor to use, quoting the known vendors from `bun <vendor-clients>/dispatch.ts --list-vendors` (calling the dispatcher with no vendor also returns that list in its error). Do not pick one yourself.

With no model resolved, omit `--model` and the vendor's client uses its own default. **Guard:** the resolved vendor must differ from the vendor whose model produced the work; if it is the same, say so and ask rather than dispatch.

Supported today: `gemini`, `mistral`. The live list is always `dispatch.ts --list-vendors`.

**Thinking levels differ per model.** The levels this skill asks for (`medium`, `low`) do not exist on every model. Before dispatching, check `bun <vendor-clients>/dispatch.ts <vendor> --list-thinking-modes [--model <model>]`: if the intended level is not offered, use the highest offered level below it (else the lowest offered level); if the model reports `kind: "none"`, omit `--thinking`. Never go above the intended level.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Review** | "cross-vendor review", "second opinion", "review this plan/diff with another model", plan review before building, code review after a change | `Workflows/Review.md` |

## Quick Reference

- **Provider:** any `ProviderClient` under `vendor-clients/` from a vendor other than the one that produced the work (supported today: `gemini`, `mistral`); no built-in default -- resolved per "Choosing the vendor". For the live list run `bun <vendor-clients>/dispatch.ts --list-vendors`. Invoke via the dispatcher (`dispatch.ts <vendor> ...`), not a specific client file.
- **Three modes:** `plan` (thinking `medium`), `test-spec` (thinking `medium` -- it spans the test spec + its source spec), and `code` (thinking `low`; `medium` for cross-file diffs). Never higher than `medium`; step down when a model lacks the level (see "Choosing the vendor").
- **Schema:** `review-schema.json` (skill-local, ships here) -- the provider returns typed `{verdict, mode, findings[], strengths[]}`.
- **Rubrics (the `--system-file` payload):** `References/rubric-plan.md`, `References/rubric-test-spec.md`, `References/rubric-code.md`.
- **Report shape:** `References/ReportContract.md`.
- **No fallback, ever.** A provider `ErrorVerdict` is surfaced verbatim and stops. Never switch to another model; never fabricate findings.

## The review invocation

The toolset flags and output contract live in `<vendor-clients>/USAGE.md`. This skill only fixes *which* values to pass for a review:

```bash
bun <vendor-clients>/dispatch.ts <vendor> \
  [--model <model>] \
  --subject /tmp/cvr-subject-<slug>.md \
  --system-file <skill>/References/rubric-<mode>.md \
  --responseSchema <skill>/review-schema.json \
  --thinking <medium for plan/test-spec | low for code, stepped down if the model lacks it> \
  --caller crossvendorreview
```

(`<vendor>` and `<model>` are resolved per "Choosing the vendor" -- never a silent default; `<skill>` is this skill's directory.) Review-specific points:

- **`--subject`** must hold the **RAW, VERBATIM bytes** of the artifact under review -- exact file contents, exact diff, exact plan-section text. **Never a rendered, summarized, pretty-printed, or reformatted view.** Reformatting the subject IS reviewing it, and it poisons the result (the provider reviews your rendering and returns findings about *your formatting*). See `Workflows/Review.md` Step 1 for exactly what to include per mode.
- **`--system-file`** is the fixed per-mode rubric -- pass the reference file path directly; do not improvise a rubric.
- **`--responseSchema`** is the skill-local `review-schema.json` -- it forces the typed review JSON.
- On success, the result's **`json` field IS the review** (typed per the schema) -- reshape it into the report block (see `References/ReportContract.md`); do not add, drop, or soften any finding. On an `ErrorVerdict`, surface it verbatim and stop.

## The hard rules (why this skill exists)

1. **The calling agent does NOT review the subject with its own reasoning.** It does not open the target source files to form an opinion. Its job is package -> dispatch -> collect -> reshape. The only cognition that evaluates the subject is the provider's, returned as JSON. (This skill exists *because* a prior same-vendor version self-reviewed instead of delegating -- the structural fix is to never let a same-family agent host the review.)
2. **The provider call MUST actually happen.** Proof of a real review is a line in the provider-calls trail (`<provider-calls-dir>/<provider>/<model>.jsonl`; location from `vendor-clients/core/config.ts`) for this run. If no provider call was dispatched, there is no review -- say so; do not invent one.
3. **On `ErrorVerdict`, surface it verbatim and stop.** No fallback to another model. No fabricated findings.

## Examples

**Example 1: Plan review before building**
```
User: "Cross-vendor review this plan before I build it."
-> Invokes Review workflow, mode=plan
-> Writes the plan's goal, acceptance criteria, scope boundary, and verification approach (verbatim) to /tmp/cvr-subject-<slug>.md
-> Fires `bun <vendor-clients>/dispatch.ts <vendor> --subject ... --system-file rubric-plan --responseSchema review-schema.json --thinking medium --caller crossvendorreview`
-> Collects the JSON, reshapes into the CROSS-VENDOR REVIEW block (the provider's findings/verdict)
```

**Example 2: Code review after a change**
```
User: "Get a second opinion on this diff."
-> Invokes Review workflow, mode=code
-> Writes the diff + the criteria it was meant to satisfy + the verification evidence to /tmp/cvr-subject-<slug>.md
-> Fires the dispatcher (thinking low), collects, reshapes
-> Returns the provider's claims-vs-evidence / silent-failure / branch-coverage findings
```

**Example 3: Provider not set up**
```
User: "Cross-vendor review this with a vendor that isn't installed/configured."
-> The client returns a setup-required (or skipped) ErrorVerdict naming what's missing
-> Surfaces that ErrorVerdict verbatim and stops -- no fallback to another model
   (for deps/credential remedies, see USAGE.md's two setup-required cases)
```

## Gotchas

- **The calling agent must not Read the target source to "help."** The moment it opens the reviewed code to form its own view, it has become the reviewer and defeated the entire point (a non-same-vendor lens). Package the payload from what it was given; let the provider read and judge.
- **Collect the result before reshaping.** If you dispatch as a background job, wait for it to finish (or read its output file) before building the report; don't reshape before the JSON is back.
- **`CallResult.json` IS the review.** The `json` field is the typed review. If `json` is somehow absent, parse `text` as JSON; if that fails, surface a one-line failure -- never fabricate.
- **No provider-call trail line = no review happened.** Always confirm the call landed in the provider-calls trail (location per `USAGE.md`) before claiming a review was performed.
