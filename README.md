# ai-tools

Various AI/LLM/harness-related tools and utilities. Each top-level directory is a
self-contained component with its own docs; they may reference each other but each stands
on its own.

## Components

| Directory | What it is |
|-----------|------------|
| [`vendor-clients/`](./vendor-clients/) | A generic toolset for calling LLM vendors from the CLI and getting back structured, typed output -- one uniform interface across vendors, a routing dispatcher, vendor discovery, per-vendor rate-limit budgeting, and a local call trail. Ships a Gemini client; adding more is a small, defined task. See its [README](./vendor-clients/README.md) (concepts, adding a vendor) and [USAGE](./vendor-clients/USAGE.md) (how to invoke). |
| [`cross-vendor-review/`](./cross-vendor-review/) | A skill/playbook for getting a plan, test spec, or code change reviewed by a **non-Anthropic** model (via `vendor-clients/`) -- a second opinion whose cognition is the other vendor's, to catch the blind spots a same-family reviewer would share. See its [SKILL.md](./cross-vendor-review/SKILL.md). |
| [`agent-session-analysis/`](./agent-session-analysis/) | Measures what a Claude Code agent actually spends its time doing over a date window -- working time, tokens, per-session work-type, and knowledge-base read/write usage -- from session transcripts. Built on three strictly-separated epistemic tiers (MEASURED / CLASSIFIED / INDICATIVE) so an honest usage picture never gets conflated into a vanity number. See its [README](./agent-session-analysis/README.md) (overview), [RUNBOOK](./agent-session-analysis/RUNBOOK.md) (how to run), and [METHODOLOGY](./agent-session-analysis/METHODOLOGY.md) (the why). Run data stays local; only the methodology + tools are shared. |
| [`project-knowledgebase/`](./project-knowledgebase/) | A file-based **project knowledge base** pattern for working with AI agents, plus a ready-to-use directory template that implements it: a small, predictable set of plain files an agent loads selectively (tiered loading) so each conversation starts oriented instead of cold. Ships the blank [`project-template/`](./project-knowledgebase/project-template/) and a downloadable `project-template.zip` of it. See its [README](./project-knowledgebase/README.md) (the concept) and the template's own [README](./project-knowledgebase/project-template/README.md) (setup + agent protocol). |

## License

Apache-2.0 (see [`LICENSE`](./LICENSE)), unless a specific directory states otherwise in its own README/LICENSE.
