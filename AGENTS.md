# ai-tools -- agent guide

Repo-wide rules for agents (and people) working in this repository. Each component may add its own `AGENTS.md`; its rules add to these.

- **Layout:** each top-level directory is a self-contained component with its own README (and, where present, its own AGENTS.md). Read the component's docs before changing it.
- **Public repo (Apache-2.0):** no private paths, usernames, hostnames, or ties to any personal agent setup. Run data and personal content stay out of the repo (see `.gitignore`).
- **Plain ASCII** in code and docs: `-` not em/en dashes, straight quotes, `...` not the ellipsis character.
- **Branches:** work on a feature branch; never commit directly to `main`.
- **Braces:** always brace block bodies, even a single statement -- `if (x) { return y; }`, never `if (x) return y;` -- so a later edit cannot add a line that looks inside the block but is not. Single-expression lambdas keep the short form.
- **Parentheses in formulas:** group explicitly rather than relying on precedence -- `((a - b) / b) * 100`, not `(a - b) / b * 100` -- so the intent is visible and an edit cannot silently change the result.
