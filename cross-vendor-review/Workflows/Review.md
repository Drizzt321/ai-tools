# Review -- dispatch a plan/code review to a non-Anthropic provider

This workflow is executed by the **calling agent**. It packages a review payload, dispatches it to a non-Anthropic vendor (via `dispatch.ts <vendor>`; default `gemini`), collects the typed JSON, and reshapes it into the report block. The calling agent never reviews the subject itself.

`<vendor-clients>` is the toolset directory, resolved per SKILL.md's "Locating the toolset" (env var `VENDOR_CLIENTS_HOME`, else `../vendor-clients/`, else ask); `<skill>` is this skill's directory. Once located, the mechanics of invoking the toolset (the `dispatch.ts` entry point, flags, output contract, vendor discovery, setup-required handling) live in `<vendor-clients>/USAGE.md`. This workflow covers only the review-specific procedure.

## Inputs (from the request / context)

| Input | Values | Notes |
|-------|--------|-------|
| `mode` | `plan` \| `test-spec` \| `code` | `plan` = plan sections before building; `test-spec` = a test specification / coverage matrix reviewed against the source spec it derives from (end-stage planning, no code yet); `code` = a diff + the criteria it was meant to satisfy + verification evidence after a change. |
| `subject` | a plan/spec path; OR the test spec + its source spec section(s) as text; OR the diff + criteria list + verification evidence as text | What gets reviewed. |
| `provider` | default `gemini` | Any vendor from `dispatch.ts --list-vendors`. A vendor that isn't installed/configured returns a `setup-required`/`skipped` ErrorVerdict -- surface it. |
| `thinking` | default `medium` for `plan` and `test-spec`, `low` for `code` | Override to `medium` for cross-file diffs; keep `code` at `medium` or below. |
| `dispatch` | default `async` | `async` = background job (collect later). `sync` = block and collect inline (use only when the review IS the current step). |

## Steps

### 1. Write the subject payload to a temp file

Use a file write to build `/tmp/cvr-subject-<short-slug>.md`. A temp file via `--subject`, not `--prompt`: the payload is large and multi-line; a command-line string would mangle it.

**THE LOAD-BEARING RULE: the subject is RAW, VERBATIM bytes -- never a rendered, summarized, pretty-printed, or reformatted view.** The provider must see exactly what the machine sees. If you reformat (e.g. render CSV rows as `0:val | 1:val`, collapse whitespace, truncate long values, "clean up" for readability), the provider reviews *your rendering* and returns findings about *your formatting* -- false criticals that are packaging artifacts, not real defects. Reformatting the subject is a form of reviewing it. Don't.

How to assemble it (a brief framing header is fine; the artifact content must be verbatim):

- **`mode=plan`:**
  - Copy, verbatim, the parts of the plan that define it: its goal, the acceptance criteria, what is in/out of scope, and how it will be verified -- whatever headings the plan uses. Do not paraphrase the criteria or re-number them.

- **`mode=test-spec`:**
  - The test specification under review, verbatim (the full file bytes -- read as-is, no reformatting of the test tables).
  - The source spec section(s) the test spec derives from, verbatim -- the reviewer needs the contracts to coverage-check against. Copy the relevant module/section bytes, not a summary.
  - A short plain-text `--- path ---` separator before each block is fine (labeling, not reformatting).
  - A one-line note of which file is the test spec vs the source spec helps. Keep it to labeling.

- **`mode=code`:**
  - The change itself, verbatim: paste the actual `git diff` output, OR the exact file contents (read as-is -- do not re-indent, re-wrap, or annotate inline). For data/fixture files, include the actual file bytes, not a tabular summary of them.
  - The criteria the code was meant to satisfy (verbatim).
  - The verification evidence (verbatim).
  - A short plain-text note of which file each block came from is fine (e.g. a `--- path/to/file.csv ---` separator line) -- that is labeling, not reformatting the content.

**A useful self-check before you dispatch:** "If the provider diffed my subject file against the real artifact on disk, would the artifact content match byte-for-byte?" If not, you have rendered/summarized it -- redo it raw.

**Do NOT open the reviewed source to form your own opinion.** Assemble the payload from what you were given (or read the file solely to copy its bytes into the subject -- copying is allowed; judging is not). The provider reads and judges.

### 2. Choose the rubric (the provider's system prompt)

The rubric is fixed per mode -- do not improvise it. Use the file directly as `--system-file`:
- `mode=plan` -> `<skill>/References/rubric-plan.md`
- `mode=test-spec` -> `<skill>/References/rubric-test-spec.md`
- `mode=code` -> `<skill>/References/rubric-code.md`

(No need to copy it to `/tmp` -- pass the reference file path straight to `--system-file`.)

### 3. Dispatch via the dispatcher

Build the command (the dispatcher routes to the chosen vendor; see `USAGE.md` for flag/output details):

```bash
bun <vendor-clients>/dispatch.ts <provider> \
  --subject /tmp/cvr-subject-<short-slug>.md \
  --system-file <skill>/References/rubric-<mode>.md \
  --responseSchema <skill>/review-schema.json \
  --thinking <medium for plan | low for code> \
  --caller crossvendorreview
```

(`<provider>` defaults to `gemini`. The flags here are the common toolset flags documented in `USAGE.md`; this step only fixes which review-specific values to pass.)

- **`async` (default):** run this as a background job. It returns immediately; keep working. The CLI bootstraps deps, resolves the key, gates the budget, locks the model, and writes the call trail itself -- do not pre-check any of that.
- **`sync`:** run the same command in the foreground and read stdout directly.

For **parallel** multi-provider review, dispatch N background jobs (one per provider) and collect them all.

### 4. Collect stdout -- ONE JSON line -- and branch

When the job completes (read its output, or read the output file):

- **`ErrorVerdict`** (`{"verdict": "unavailable" | "setup-required" | "rate-limited" | "skipped" | "error", "reason": ...}`): surface it **verbatim** and **stop**. No review happened. Do NOT fall back to another provider or to a same-vendor review. Do NOT invent findings.
- **`CallResult`** (`{"text", "json", "tokensUsed", "modelUsed", "notes?"}`): the **`json` field IS the review** -- typed per `review-schema.json`. This is what you reshape. (If `json` is absent, parse `text` as JSON; if that fails, surface a one-line failure -- never fabricate.)

### 5. Verify the call actually happened

A review block is only valid if a real provider call backs it. Confirm a trail line exists for this run in the provider-calls trail (its location is documented in `USAGE.md` -- the "Configuration (paths)" section; default `<vendor-clients>/provider-calls/<provider>/<model>.jsonl`). No trail line => no review => say so. Do not claim a review without a backing call.

### 6. Reshape the JSON into the report block and return

Populate the `CROSS-VENDOR REVIEW` block (see `References/ReportContract.md`) from the schema `json`. The framing is yours; every finding / strength / verdict comes straight from the JSON -- do not add, drop, or soften any. That block is the entire output: no narration of the steps above, no description of the shell call.

## Notes

- **One subject, one rubric, one schema, one call per provider.** Keep it deterministic.
- **You are glue, not a reviewer.** If you find yourself writing review prose of your own, stop -- the review is the provider's JSON.
- **Budget/token accounting is the CLI's job** (it auto-records the daily request count and writes the trail). Do not report it.
