# Gemini client -- setup

Provider-specific setup for the `gemini` client. For how to *invoke* the toolset (the dispatcher,
flags, output contract, the general `.env` resolution), see `../USAGE.md`. This file covers only what
Gemini itself needs: its dependencies and its API credential.

## 1. Dependencies

The Gemini client needs two runtime packages: `@google/genai` (the API SDK) and `proper-lockfile`
(used by the daily-budget counter). Install them in **this** directory:

```bash
cd <vendor-clients>/gemini
bun install
```

Notes:
- Deps are only needed for an actual model call. Query/discovery modes (`--list-models`,
  `--list-thinking-modes`, `--help`, and `dispatch.ts --list-vendors`) work with nothing installed.
- If you call before installing, the client returns a `setup-required` verdict naming the missing
  package(s) -- it does not auto-install. Run `bun install` then (obeying any install policy you have).

## 2. API key

Get a key from Google AI Studio: https://aistudio.google.com/apikey (a free tier is available).

The client reads the key from the environment, in this precedence:

1. **`GEMINI_API_KEY`** -- used first if set.
2. **`GOOGLE_API_KEY`** -- used if `GEMINI_API_KEY` is absent. (The `@google/genai` SDK also recognizes
   this name.) If BOTH are set and differ, the client warns on stderr and uses `GEMINI_API_KEY`.

Provide the key either as a real environment variable, or via a `.env` file that the toolset loads (the
`.env` locations and their precedence are documented in `../USAGE.md`, "Configuration (paths)"). For
example, as a shell export:

```bash
export GEMINI_API_KEY=your-key-here
```

If no key resolves, a call returns a `setup-required` verdict saying the key is not set -- configure it
and retry. (Credentials are checked at call time; discovery/query modes need no key.)

## 3. Optional: relocate the budget counter

The client keeps a per-model requests-per-day counter (the free tier's RPD limit is per-project, so the
counter can be shared across machines to enforce one budget). By default it lives next to this client's
code. To put it elsewhere -- e.g. a synced folder, or a writable dir outside the repo -- set:

```bash
export VENDOR_CLIENTS_GEMINI_STATE=/path/to/state-dir
```

This is optional; omit it and the counter defaults to this directory.

## Verify

With deps installed, a no-credential check confirms the install + this client resolves:

```bash
bun <vendor-clients>/dispatch.ts gemini --list-models
```

It should print a JSON model list and exit 0.
