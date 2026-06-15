# vendor-clients

A small, generic toolset for calling LLM vendors from the command line and getting back **structured,
typed output** -- with a uniform interface across vendors, built-in discovery, per-vendor rate-limit
budgeting, and a local call trail. One vendor ships today (`gemini`); adding more is a small, well-defined
task (see "Adding a vendor").

- **How to invoke it** (the dispatcher, flags, discovery, output contract, setup-required handling):
  see **[`USAGE.md`](./USAGE.md)**.
- **Per-vendor setup** (deps, credentials): see each vendor's `SETUP.md`, e.g.
  [`gemini/SETUP.md`](./gemini/SETUP.md).

## Concepts

- **`ProviderClient` (the contract).** An abstract base class in `core/ProviderClient.ts`. "A thing that
  can call a model." It is task-agnostic -- it knows how to talk to one vendor's API and nothing about
  *what* the call is for. It also homes the shared CLI machinery (argv parsing via `node:util` `parseArgs`,
  unknown-flag rejection, the `runAsCli` entry helper) so every vendor inherits it. The base stays a
  lightweight, filesystem-free, SDK-free leaf; vendor SDKs load lazily inside a vendor's `call()`.
- **A vendor client (e.g. `GeminiClient`).** A subclass under its own directory (`gemini/`) that `extends
  ProviderClient`, implements the contract against a specific API, and declares any vendor-specific CLI
  flags. The ONLY vendor-specific code lives here.
- **The dispatcher (`dispatch.ts`).** The front door: `bun dispatch.ts <vendor> [flags]` routes to the
  named vendor's client. It is a near-pure proxy (it interprets only the vendor token and `--help`) plus
  the discovery command `--list-vendors`. The inline `VENDORS` map is the registry.
- **The shared CLI runner (`core/ProviderCli.ts`).** Turns a constructed client into a one-off CLI:
  reads the parsed flags, does run-time file I/O (subject/system/schema files), makes the call, writes
  the trail, renders `--help`.
- **Config (`core/config.ts`).** Cross-vendor path resolution + `.env` hydration, anchored at
  `VENDOR_CLIENTS_HOME` (default: this directory). Vendor-specific state is NOT here -- a vendor owns its
  own (e.g. gemini's per-model budget counter, relocatable via `VENDOR_CLIENTS_GEMINI_STATE`).
- **Structured output.** Pass `--responseSchema <file>` and the client asks the API for JSON conforming
  to that schema (constrained decoding where the provider supports it). Output is one JSON line:
  a `CallResult` on success, or a structured `ErrorVerdict` otherwise. See `USAGE.md`.

## Layout

```
vendor-clients/
  README.md            <- you are here
  USAGE.md             <- how to invoke (authoritative)
  dispatch.ts          <- front door + VENDORS registry + --list-vendors
  dispatch.test.ts
  core/
    ProviderClient.ts  <- the abstract contract + shared CLI machinery (parseArgs, runAsCli)
    ProviderCli.ts     <- the shared CLI runner + help rendering
    ProviderLog.ts     <- the call trail
    config.ts          <- cross-vendor paths + .env hydration
  gemini/              <- a vendor client (template for new ones)
    GeminiClient.ts    GeminiBudget.ts    gemini-tier-limits.json
    package.json       tsconfig.json      SETUP.md
```

## Adding a vendor

A new vendor is a directory + a class that implements the contract + one line in the registry.

1. **Create the directory** `vendor-clients/<vendor>/` with a `<Vendor>Client.ts`. Use `gemini/` as the
   template.

2. **Implement the class** -- `export class <Vendor>Client extends ProviderClient`:
   - Implement the **abstract members**: `provider` (the stable lowercase id, e.g. `"openai"`), `call`,
     `maxBundleTokens`, `isConfigured`, `depsReady`, `models`, `thinkingModes`.
   - **Honoring `CallOpts.responseSchema` is vendor-specific -- how you do it depends on the API.**
     `responseSchema` is the caller's *intent* ("return JSON matching this shape"); each `call()` decides
     how to satisfy it:
     - Native structured-output APIs (like Gemini): pass the schema as a SEPARATE request parameter (the
       SDK's `responseSchema` / `response_format` field) so the model is constrained to valid JSON. This
       is what `GeminiClient` does -- the schema never goes into the prompt.
     - Schema-via-tool-use APIs (e.g. Anthropic): map the schema onto a forced tool's input schema.
     - APIs/CLIs with NO structured-output support (e.g. a `codex exec`-style wrapper): there is no
       separate field -- you must **inject the schema into the prompt** ("return JSON matching: ...") and
       then PARSE + VALIDATE the returned text against it yourself, returning an `ErrorVerdict`
       ("unavailable", malformed response) if it doesn't conform. Prompt-injected schemas are not
       enforced by the API, so the parse/validate step is on you -- do not assume conforming output.
     The interface is the same (`CallOpts.responseSchema` in, `CallResult.json` out); only the mechanism
     inside `call()` differs.
   - **Vendor CLI flags come in a PAIR -- if the vendor has any, you implement BOTH:**
     1. **Declare** them: override `protected static vendorCliOpts(): CliOptSpec[]` -- return ONLY the
        vendor's own flags (the common flags are inherited; do NOT override `getCliOpts`). This is what
        makes the parser ACCEPT the flags and what `--list-vendors` / `--help` show.
     2. **Parse + apply** them: in your constructor, after `super(argv)`, call your own `parseCliOpts()`
        that reads each declared flag via `this.vendorFlag(name)`, validates it, and assigns it to a field.
     Declaring without parsing means the flag is accepted but silently ignored; parsing a flag you didn't
     declare means it is rejected as unknown. Keep the two in sync.
   - Write the constructor: `constructor(argv: string[]) { super(argv); this.parseCliOpts(); }`. The base
     constructor parses the common flags into `this.common` and rejects unknown flags; your `parseCliOpts()`
     (called AFTER `super()` -- never let the base call it) does the vendor parse+apply. Declare vendor
     config fields WITHOUT initializers (`x!: T`) -- a field initializer runs after `super()` and would
     clobber what `parseCliOpts()` set.
   - Throw `CliUsageError` (from `../core/ProviderClient.ts`) for any bad flag value; it is caught at the
     entry boundary and mapped to exit code 2.
   - Add the one-line entry block at the foot of the file:
     ```ts
     if (import.meta.main) await <Vendor>Client.runAsCli(process.argv, "bun <Vendor>Client.ts");
     ```
   - Lazy-import the vendor SDK INSIDE `call()` (not at module top level) so the class loads without deps
     installed, and `depsReady()` can report a missing tree first.

3. **Register it in `dispatch.ts`** -- add one line to the `VENDORS` map:
   ```ts
   export const VENDORS: Record<string, () => Promise<ProviderClientClass>> = {
     gemini: async () => (await import("./gemini/GeminiClient.ts")).GeminiClient,
     <vendor>: async () => (await import("./<vendor>/<Vendor>Client.ts")).<Vendor>Client,  // <- add
   };
   ```
   The value lazy-imports the CLASS (typed `ProviderClientClass`, which captures `new (argv)` + the static
   `getCliOpts()` + `runAsCli()`), so registering it is type-checked and only the chosen vendor's module
   loads at runtime.

4. **Dependencies (if any)** -- give the vendor its own `package.json` + `tsconfig.json` (copy gemini's),
   and document install + credentials in a `<vendor>/SETUP.md` (see `gemini/SETUP.md`). Use the
   `VENDOR_CLIENTS_<VENDOR>_<THING>` env-var convention for any vendor-specific overrides.

5. **Verify** -- `bun dispatch.ts --list-vendors` should now include the new vendor with its flags;
   `bun dispatch.ts <vendor> --help` should render its help; `bun dispatch.ts <vendor> --list-models`
   should work with no credentials.

That's it -- the common flags, help layering, unknown-flag rejection, the call trail, and `--list-vendors`
discovery all come for free from the base class and the dispatcher.

## Development

```bash
cd vendor-clients/gemini && bun install   # install the (only) vendor with deps
bunx tsc --noEmit                          # typecheck the component (run from vendor-clients/)
bun test                                   # run the dispatcher/contract tests
```
