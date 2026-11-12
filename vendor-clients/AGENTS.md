# vendor-clients -- agent guide

Component rules for `vendor-clients/`. They add to the repo-wide `../AGENTS.md`. `README.md` and `USAGE.md` stay authoritative for everything not listed here.

- **Read first:** `README.md` (concepts, "Adding a vendor") and `USAGE.md` (invocation and output contract). Do not restate them here.
- **Scope:** vendor-clients makes a call and returns a response. It has no default vendor; callers own defaults and policy.
- **Contract:** `core/ProviderClient.ts` stays free of filesystem access and SDKs; vendor SDKs load lazily inside `call()`. No fallback to another model, no retries. Every failure is an `ErrorVerdict` from the existing set (`setup-required` = user-fixable, `unavailable` = transient, `error` = our bug or unexpected).
- **CLI:** stdout is exactly one JSON line; diagnostics go to stderr. Exit 0 = handled, 2 = usage error. Query modes (`--list-*`, `--help`) never touch the network or need a key. Every vendor flag is both declared and parsed. Vendor config fields have no initializers.
- **Network:** each vendor keeps all network I/O in one transport function that tests replace; the transport itself is tested against a mocked `fetch`.
- **Catalogs:** curated model data ships as JSON next to its client; a missing or malformed catalog throws.
- **Secrets:** never log or embed a key; keys come only through `core/config.ts`. Never commit a `.env`.
- **`.env` gotcha:** `VENDOR_CLIENTS_ENV_FILE` overwrites every key it sets, including `VENDOR_CLIENTS_HOME`, which silently moves the call log.
- **Tests:** from `vendor-clients/`, `bun test` and `./gemini/node_modules/.bin/tsc --noEmit -p .` (plain `bunx tsc` cannot find it). Tests never make live calls; they point `VENDOR_CLIENTS_HOME` at an empty temp dir and unset `VENDOR_CLIENTS_ENV_FILE`. Live checks are manual.
- **Dependencies:** bun only; exact pins; a separate `package.json` per vendor; as few as possible; new ones need maintainer approval.
