# Mistral client -- setup

Provider-specific setup for the `mistral` client. For how to *invoke* the toolset (the dispatcher,
flags, output contract, the general `.env` resolution), see `../USAGE.md`. This file covers only what
Mistral itself needs.

## 1. Dependencies

None. The client talks to Mistral's REST API with the runtime's built-in `fetch`, so there is nothing
to install and `depsReady()` always reports ready.

## 2. API key

Get a key from Mistral's console: https://console.mistral.ai (a free tier is available; a Le Chat /
Vibe subscription key works too).

The client reads **`MISTRAL_API_KEY`** -- the same name Mistral's own docs and the Vibe CLI use -- from
the environment, either as a real environment variable or via a `.env` file that the toolset loads
(locations and precedence in `../USAGE.md`, "Configuration (paths)"):

```bash
export MISTRAL_API_KEY=your-key-here
```

If no key resolves, a call returns a `setup-required` verdict saying the key is not set. Query modes
need no key.

**Data handling.** On Mistral's free tier, prompts may be used to train their models unless you turn
that off in the console. Do not send anything private on a key where training is allowed.

## 3. Models and reasoning

`--list-models` prints the curated set from `mistral-models.json`: Mistral's own models and the
third-party models Mistral serves on the same endpoint. Each model lists its `lineage` (who trained
the weights: `mistral`, `z.ai`, `deepseek`) and its `host` (always `mistral`: the third-party models
run on Mistral's own infrastructure, so prompts go to Mistral either way). Which ones a given key can reach depends on
the account's plan; a model outside it returns a `setup-required` verdict naming the model (HTTP 403).

`--thinking` maps to Mistral's `reasoning_effort`. Each model has its own documented levels and a
default applied when `--thinking` is omitted; `--list-thinking-modes --model <id>` shows both. A level
the model does not document is rejected before any call. Reasoning traces are dropped from the
output; only the answer text is returned.

## 4. Rate limits

There is no local budget counter. A 429 comes back as a `rate-limited` verdict with `retry_after_ms`
when Mistral sends a `Retry-After` header. The client never retries on its own.

## Verify

A no-credential check confirms the client resolves:

```bash
bun <vendor-clients>/dispatch.ts mistral --list-models
```

It should print a JSON model list and exit 0.
