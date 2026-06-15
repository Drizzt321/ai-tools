# ai-tools

Various AI/LLM/harness-related tools and utilities. Each top-level directory is a
self-contained component with its own docs; they may reference each other but each stands
on its own.

## Components

| Directory | What it is |
|-----------|------------|
| [`vendor-clients/`](./vendor-clients/) | A generic toolset for calling LLM vendors from the CLI and getting back structured, typed output -- one uniform interface across vendors, a routing dispatcher, vendor discovery, per-vendor rate-limit budgeting, and a local call trail. Ships a Gemini client; adding more is a small, defined task. See its [README](./vendor-clients/README.md) (concepts, adding a vendor) and [USAGE](./vendor-clients/USAGE.md) (how to invoke). |
| [`cross-vendor-review/`](./cross-vendor-review/) | A skill/playbook for getting a plan, test spec, or code change reviewed by a **non-Anthropic** model (via `vendor-clients/`) -- a second opinion whose cognition is the other vendor's, to catch the blind spots a same-family reviewer would share. See its [SKILL.md](./cross-vendor-review/SKILL.md). |

## License

Apache-2.0 (see [`LICENSE`](./LICENSE)), unless a specific directory states otherwise in its own README/LICENSE.
