# project-knowledgebase

A file-based **project knowledge base (KB)** pattern for working with AI agents -- and a ready-to-use
directory template that implements it. The idea: give every project a small, predictable set of
plain files on disk that an agent can load *selectively*, so each new conversation starts oriented
instead of cold.

## The concept

AI agents lose context between conversations. Every new session starts from nothing, and project
knowledge scattered across chat logs, memory features, and ad-hoc docs is expensive to re-discover
and easy to get wrong. A project KB fixes that by making **files on disk the source of truth** --
not chat history, not a memory system, not a database. Anything a tool can read, any agent can use.

Three principles make it work:

- **Predictable structure.** A fixed, guessable layout -- plans live in `plans/`, decisions in
  `03-decisions.md`, reference material in `reference/`. You (or an agent) can predict where a piece
  of information lives without consulting an index.
- **Tiered loading.** Context windows are finite, so the KB is organized so an agent loads only
  what's relevant. A quick question reads just the brief (~500 tokens); a deep implementation
  session pulls in a few more documents. Nothing ever loads everything.
- **Self-describing.** Each KB carries a `DOCUMENT-MAP.md` that indexes every file and says when to
  load it -- the agent's entry point for deciding what's relevant to the current task.

The loading tiers, concretely:

| Tier | Files | When |
|------|-------|------|
| **1 -- always** | `00-project-brief.md` | Orient any conversation (vision, goals, current phase) |
| **2 -- working sessions** | `02-status.md`, `03-decisions.md`, `04-backlog.md` | Active work, implementation decisions, planning |
| **On demand** | `plans/`, `reference/`, `output/`, ... | Only when the conversation is about that specific topic |

## What's in this component

| Path | What it is |
|------|------------|
| [`project-template/`](./project-template/) | The blank KB template -- the directory you copy to start a new project KB. Its own [`README.md`](./project-template/README.md) is the full guide: setup, agent configuration, per-file roles, and the agent protocol for creating and loading KBs. [`README.html`](./project-template/README.html) is a styled, shareable render of the same. |
| [`project-template.zip`](./project-template.zip) | The same template as a single downloadable file, for handing to someone else. Unpacks to `project-template/`. Rebuild it from the directory whenever the template changes (see below) so the two never drift. |

## Using it

1. **Copy** `project-template/` to a sibling directory named after your project.
2. **Do not** copy `README.md`, `README.html`, or the zip into the new project -- those document the
   template itself. A project's `00-project-brief.md` is its README; `DOCUMENT-MAP.md` is its entry
   point. (See `project-template/README.md` for the full agent protocol.)
3. **Tell your agent** where KB directories live so it can discover, copy, and fill them in. The
   template README has copy-paste instructions for Claude Code, claude.ai, Cowork, and other agents.

## Maintenance notes

- **Keep the zip in sync with the directory.** The zip is a packaged copy, not a separate source.
  After editing anything under `project-template/`, rebuild it from this component directory:

  ```
  cd project-knowledgebase
  rm -f project-template.zip
  zip -r project-template.zip project-template -x '*.zip' -x '*.DS_Store'
  ```

  Building from here makes the archive unpack to `project-template/`, matching the on-disk name.
- **Empty directories are kept with `.gitkeep`.** The template's value is its predictable skeleton,
  but git (and a zip built from a git checkout) won't preserve empty directories. Each empty dir
  carries an empty `.gitkeep` so the skeleton survives both git and extraction. They are harmless
  placeholders; delete them once a directory has real content if you like.

## License

Apache-2.0 (see the repo root [`LICENSE`](../LICENSE)).
