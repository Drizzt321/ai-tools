# vendor-clients -- usage

How to invoke this toolset. It is the single source of truth for invocation; other consumers
(a skill, a script, an agent-generated one-off call) should reference this file rather than
re-document the mechanics.

The toolset is **provider-agnostic**: a generic contract (`core/ProviderClient`) plus one or more
vendor implementations (e.g. `gemini/`). You call *a vendor* and get back structured output. The
toolset itself needs no credentials; each vendor's client owns its own and reports precisely what it
needs.

## `VENDOR_CLIENTS_HOME`

You are reading this file from inside the toolset, so you have already found it (`<vendor-clients>`
in this doc = the directory containing this `USAGE.md`). The `VENDOR_CLIENTS_HOME` environment
variable still matters for two things:

- **It anchors where the toolset writes runtime state** -- the call trail and the `.env` it resolves
  are derived from it (see "Configuration (paths)" below). Default: this directory.
- **It lets an EXTERNAL caller point at this toolset** -- a script, an agent, or another tool that is
  not already inside this directory can set `VENDOR_CLIENTS_HOME` to find `dispatch.ts` and the
  clients. (Code running *inside* the toolset self-locates via `import.meta.dirname` and does not need
  the variable.)

It is the same variable `core/config.ts` reads, so setting it keeps an external caller and the code
agreed on one location.

## Entry point: `dispatch.ts`

`dispatch.ts` is the front door. Name a vendor, then pass flags:

```bash
bun <vendor-clients>/dispatch.ts <vendor> [flags]
```

A vendor's client file can also be invoked directly (`bun <vendor-clients>/<vendor>/<Vendor>Client.ts
[flags]`) -- identical behavior, lower-level. Prefer `dispatch.ts`; it is also the discovery surface.

## Discovery

- **`bun <vendor-clients>/dispatch.ts --list-vendors`** -- machine-readable JSON: every vendor and its
  full flag set (common + vendor-specific). One call tells a consumer everything it needs to build a
  valid invocation for any vendor:
  ```json
  {"vendors":[{"name":"gemini","cliOpts":[{"flag":"--prompt","takesValue":true,"description":"..."}, ...]}]}
  ```
  (A vendor whose module fails to load is reported as `{"name":"...","error":"..."}` instead of
  `cliOpts`, so one broken vendor does not sink discovery of the rest.)
- **`bun <vendor-clients>/dispatch.ts <vendor> --help`** -- human-readable help for that vendor,
  including its VENDOR-SPECIFIC OPTIONS section.
- **`bun <vendor-clients>/dispatch.ts <vendor> --list-models`** / **`--list-thinking-modes`** -- that
  vendor's model set / reasoning modes, as JSON. (All discovery/query modes are no-network and need no
  credentials.)

## Flags

**Common flags** (every vendor accepts these; one of `--prompt` / `--subject` is required for a call):

| Flag | Takes value | Meaning |
|------|-------------|---------|
| `--prompt <text>` | yes | The user prompt, literally on the command line. |
| `--subject <path>` | yes | Read the user prompt from a file (read at run time). `--prompt` wins if both given. |
| `--system <text>` | yes | System prompt / instruction. |
| `--system-file <path>` | yes | Read the system prompt from a file. `--system` wins if both given. |
| `--thinking <mode>` | yes | Reasoning effort (provider-validated; an unsupported value returns an `error` verdict). |
| `--responseSchema <path>` | yes | JSON Schema file -> structured JSON in the result's `json` field. Omitted -> free text in `text`. |
| `--model <name>` | yes | Model to use. Omitted -> the client default. |
| `--caller <name>` | yes | Tag the call-trail line with who invoked. |
| `--no-log` | no | Do not write this call to the provider-calls trail. |
| `--list-models` / `--list-thinking-modes` / `--help` | no | Query modes (no model call). |

**Vendor-specific flags:** a vendor may declare its own additional flags (e.g. gemini's `--timeout`).
To see which flags a vendor adds AND what each one does, run **`bun <vendor-clients>/dispatch.ts
<vendor> --help`** -- its "VENDOR-SPECIFIC OPTIONS" section lists each flag with a description. (For a
machine-readable form, `--list-vendors` returns the same flags with their descriptions as JSON.) An
unknown flag for the chosen vendor is rejected with exit code 2.

## Output contract

A single line of JSON to STDOUT (diagnostics to STDERR):

- **Success** -- `CallResult`: `{"text", "json"?, "tokensUsed", "modelUsed", "notes"?}`. `json` is present
  only when `--responseSchema` was supplied.
- **Non-success** -- `ErrorVerdict`: `{"verdict": "unavailable"|"setup-required"|"rate-limited"|"skipped"|"error", "reason", "retry_after_ms"?, "anomaly"?}`.
- Query modes print their own JSON (`--list-models`, `--list-thinking-modes`, `--list-vendors`).

**Exit codes:** `0` = handled (the verdict in the JSON carries success/failure); `2` = usage error
(unknown flag, no `--prompt`/`--subject`, or an unreadable `--subject`/`--responseSchema` file).

## The two `setup-required` cases

A call may return `{"verdict":"setup-required","reason":...}`. Two common causes, handled reactively
(do NOT run these proactively before every call):

- **Deps not installed.** The reason says the vendor's deps are missing. The fix is `bun install` in
  that vendor's directory (`cd <vendor-clients>/<vendor> && bun install`) -- but obey any stated
  preferences for installing software (a different package manager, approval required, a frozen
  lockfile). Surface the suggested command; let the consumer's conventions govern. (Query/discovery
  modes work with no deps; only a live call needs them.)
- **Credentials not configured.** The reason names the missing credential for that vendor. Report which
  PROVIDER is unconfigured and relay the reason verbatim. Do not assume a specific key name -- the
  client states it.

## Samples

```bash
# Discover what's available:
bun <vendor-clients>/dispatch.ts --list-vendors

# A one-off call with a literal prompt:
bun <vendor-clients>/dispatch.ts gemini --prompt "Summarize in one line." --thinking low

# A call whose prompt is a (large, multi-line) file, with structured JSON output:
bun <vendor-clients>/dispatch.ts gemini \
  --subject ./input.md \
  --responseSchema ./my-schema.json \
  --thinking medium

# Expected success shape (one JSON line):
# {"text":"...","json":{...},"tokensUsed":1234,"modelUsed":"gemini-3.5-flash"}
```

## Configuration (paths)

`core/config.ts` resolves the paths the toolset writes to, all anchored at `VENDOR_CLIENTS_HOME`
(default: the `vendor-clients/` directory):

- **provider-calls trail** -- `<vendor-clients>/provider-calls/<provider>/<model>.jsonl` (suppress per
  call with `--no-log`).
- **`.env`** -- `<vendor-clients>/.env` (gap-fill) and `VENDOR_CLIENTS_ENV_FILE` (override). API keys may
  come from the environment or these files; the override file wins over a shell var, the default `.env`
  fills gaps only.

Vendor-specific runtime state lives with the vendor (e.g. gemini's per-model daily budget counter
defaults next to its code, relocatable via `VENDOR_CLIENTS_GEMINI_STATE`).
