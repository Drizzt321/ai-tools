# Project Knowledge Base Template

A structured directory template for maintaining durable project knowledge that AI agents (and humans) can navigate efficiently. Designed for use with AI coding assistants like Claude Code, but works with any agent that reads files.

## The Problem This Solves

AI agents lose context between conversations. Every new session starts cold. Project knowledge scattered across chat logs, docs, and memory is expensive to re-discover and easy to get wrong.

This template gives each project a small, predictable set of files that an agent can load selectively based on what kind of work is happening — without dumping everything into context at once.

## Setup

### 1. Place the Template

Put this `project-template` directory inside the parent directory where you want your project knowledge bases to live. For example:

```
C:\Users\you\Documents\KnowledgeBases\project-template\     (Windows)
/home/you/KnowledgeBases/project-template/                   (Linux)
~/KnowledgeBases/project-template/                           (macOS)
```

The template stays here as a reference. When you (or your agent) start a new project, the agent copies the template directory, renames it, and fills in the files from your conversation.

### 2. Configure Your Agent

Your agent needs to know where KB directories live and how to use them. Add the following to your agent's persistent instructions, replacing `<YOUR_KB_PATH>` with your actual path:

```
Project knowledge bases are stored at <YOUR_KB_PATH>.
Each subdirectory is a project KB. The `project-template` directory
contains the blank template — copy it to create a new project KB.
To understand any project, start with its DOCUMENT-MAP.md — it indexes
all files and describes when to load each one.
```

For example, a Windows user with knowledge bases in their Documents folder would use:

```
Project knowledge bases are stored at C:\Users\jane\Documents\KnowledgeBases.
Each subdirectory is a project KB. The `project-template` directory
contains the blank template — copy it to create a new project KB.
To understand any project, start with its DOCUMENT-MAP.md — it indexes
all files and describes when to load each one.
```

Where you add this depends on your agent:

- **Claude Code:** Add it to your `~/.claude/CLAUDE.md` (user-level instructions, loaded every session). See [Anthropic's CLAUDE.md documentation](https://docs.anthropic.com/en/docs/claude-code/memory) for details on file placement and scoping.
- **claude.ai / Claude Desktop / Claude Mobile:** Add it to your **Profile Instructions** (click your initials → Settings → "Instructions for Claude"). This applies to all conversations. Alternatively, add it to a specific **Project's instructions** if you only want it scoped to that project. See [Anthropic's personalization guide](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features) and [Projects guide](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects) for details.
- **Other agents:** Consult your agent's documentation for how to add persistent system-level instructions.

That's it. Your agent can discover the template, copy it for new projects, and fill in the files based on your conversations.

### Using KB Directories as Claude Projects

Each project KB directory can also serve as a **Claude Project** — either as a chat project on claude.ai/Claude Desktop, or as a Cowork project. Since each directory is a self-contained workspace with its own files and context, it maps naturally to Claude's project model:

- **Chat Projects (claude.ai / Claude Desktop):** Create a project and upload the KB directory's files to the project knowledge base, or add `00-project-brief.md` as project instructions. See the [Projects guide](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects).
- **Cowork Projects (Claude Desktop):** Cowork can create projects directly from local folders on your computer. Point it at a KB directory and it becomes a Cowork project with its own instructions, context, and memory. See [Organize tasks with projects in Cowork](https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork) and [Getting started with Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork).

---

## Core Idea: Tiered Loading

Context windows are finite. The template is organized around a loading strategy:

- **Tier 1 (always load):** `00-project-brief.md` — enough to orient any conversation in under 500 words.
- **Tier 2 (load for working sessions):** `02-status.md`, `03-decisions.md`, `04-backlog.md` — progressively deeper context pulled in when relevant.
- **Topic-specific (load on demand):** `plans/`, `reference/` — detailed docs pulled in only when working on that specific area.

An agent starting a new conversation reads the brief. If the conversation turns to active implementation, it pulls in status and decisions. If it needs the specifics of a particular subsystem, it reads the relevant plan or reference doc. The `DOCUMENT-MAP.md` file tells it what exists and when to load each document.

This means a quick question costs ~500 tokens of context. A deep implementation session might load 3-5 documents. Nothing loads everything.

## Directory Structure

```
your-project/
  00-project-brief.md    — Vision, goals, architecture, current phase (Tier 1)
  02-status.md           — Phase status, tasks, what's next (Tier 2A)
  03-decisions.md        — Key decisions with rationale (Tier 2B)
  04-backlog.md          — Ideas, links, future exploration (Tier 2C)
  DOCUMENT-MAP.md        — File index and loading guide
  plans/                 — Actionable execution plans (per-topic)
    archive/             — Completed/deprecated plans (historical reference)
  reference/             — Research, landscape analyses, technical reference
  output/                — Finished or near-finished deliverables
    documents/           — Reports, memos, proposals, written deliverables
    diagrams/            — Flowcharts, org charts, architecture visuals
    images/              — Generated images, screenshots, visual assets
    data/                — Spreadsheets, CSVs, analysis results, exports
  ongoing/               — Operational runbooks, living process docs
  journal/               — Historical archives, session logs
  scratch/               — Working artifacts that haven't graduated yet
```

## File Roles

### 00-project-brief.md (Tier 1 — Always Loaded)

The single document an agent reads to understand your project. Contains:
- What the project is and why it exists (vision)
- Concrete goals
- High-level architecture or approach
- Current phase / immediate focus
- Top decisions that shape everything

Keep this concise — under 500 words is ideal. It should orient a cold-start conversation, not explain every detail. Link to deeper docs for specifics.

### 02-status.md (Tier 2A — Active Work)

Where you are and what's next. Phase overview table, per-phase task lists, cross-cutting TODOs. Pull this in for any conversation involving active work.

Update this file as phases progress. When a phase completes, move the detailed history to `journal/` and keep only the summary here.

### 03-decisions.md (Tier 2B — Implementation)

Currently relevant decisions with enough rationale to be useful during implementation. Each entry captures what was decided, why, and what alternatives were considered. Link to detailed analyses in `reference/` or `plans/` when they exist.

Decisions age out. When a decision is no longer load-bearing (the thing it decided is done and stable), archive it or remove it. This file should reflect the active decision landscape, not a complete history.

### 04-backlog.md (Tier 2C — Planning)

Low-friction landing zone for ideas, links, tools to evaluate, integration concepts, and half-formed thoughts. Pull this in during planning sessions, not during implementation. Things here are not commitments — they're possibilities.

### DOCUMENT-MAP.md

Central index of every file in the project. For each file: what it is, when to load it. This is what an agent reads to decide which documents are relevant to the current conversation.

Update this whenever you add or rename a file. It's the table of contents for the whole knowledge base.

### plans/

Actionable documents: implementation plans, design specs, feature breakdowns. Each plan is a self-contained document for a specific topic. An agent loads the plan relevant to the current work, not all plans.

Plans that are completed or superseded move to `plans/archive/`.

### reference/

Research findings, landscape analyses, technical reference material, API documentation summaries. Things you'd look up when you're "in the weeds" on a specific topic.

### ongoing/

Operational runbooks and living process documents — things that describe how to do recurring operations, not one-time plans.

### journal/

Historical archives. When status updates, decision logs, or phase details get long, rotate the old content here. Useful for understanding how the project evolved, but rarely loaded.

### output/

Finished or near-finished deliverables — things the agent produced that you'll use, share, or submit. Organized into subdirectories by type:

- **documents/** — Reports, memos, proposals, analyses, written deliverables. Project-specific outputs like reviews or reports can go here or in their own subdirectory under `output/` — whatever feels natural.
- **diagrams/** — Flowcharts, org charts, architecture visuals, process maps.
- **images/** — Generated images, screenshots, visual assets.
- **data/** — Spreadsheets, CSVs, analysis results, data exports.

The subdirectories are suggestions — use what fits your project, ignore what doesn't, add new ones if needed.

### scratch/

Working artifacts: drafts, explorations, calculations, intermediate outputs. When something in scratch matures, graduate it to `plans/`, `reference/`, or `output/`. When it's no longer useful, delete it.

## How Agents Should Use This

If you're an AI agent reading this, here's the protocol:

### Creating a New Project KB

When the user starts a new project or you determine one is needed:

1. Create a sibling directory named after the project, and copy in **only the project files**: `00-project-brief.md`, `02-status.md`, `03-decisions.md`, `04-backlog.md`, `DOCUMENT-MAP.md`, plus the `plans/` and `reference/` directories.
2. **Do NOT copy `README.md`, `README.html`, or `project-template.zip` into the new project** — those document the template *itself*, not any project. A project's `00-project-brief.md` is its README (the single orient-me document), and `DOCUMENT-MAP.md` is its canonical entry point. (A project may add its own `README.md` later if it has a real need — e.g. it gets published to a git remote — but it is never copied from the template.)
3. Fill in `00-project-brief.md` based on what you know from the conversation.
4. Update `DOCUMENT-MAP.md` with the project name in the directory tree.
5. The remaining files can stay as templates until content is needed.

### Loading an Existing Project KB

1. **Start with `DOCUMENT-MAP.md`** to understand what files exist and when to load them.
2. **Always read `00-project-brief.md`** at the start of any conversation about this project.
3. **Load Tier 2 files based on the task:**
   - Doing active work? Load `02-status.md`.
   - Making implementation decisions? Load `03-decisions.md`.
   - Planning or brainstorming? Load `04-backlog.md`.
4. **Load plans/reference on demand** — only when the conversation is specifically about that topic.
5. **Don't load everything.** The whole point is selective loading. If you're answering a quick question, the brief is probably enough.

### Writing Back

When you produce knowledge worth keeping:
- Implementation plans go in `plans/`.
- Research findings go in `reference/`.
- Finished deliverables go in `output/` (documents, diagrams, images, data as appropriate).
- Decisions go in `03-decisions.md` (brief entry) with detailed analysis linked from `plans/` or `reference/`.
- Update `DOCUMENT-MAP.md` when adding new files.
- Update `02-status.md` when phase status changes.
- Use `scratch/` for intermediate work that might graduate later.

## Design Principles

**Files are the source of truth.** Not chat logs, not memory systems, not databases. Files on disk that any tool can read.

**Predict where things go.** Anyone (human or agent) should be able to guess where a piece of information lives without consulting an index. Plans are in `plans/`. Decisions are in `03-decisions.md`. Reference material is in `reference/`.

**Concise over comprehensive.** Every file should be as short as it can be while remaining useful. If a document is getting long, split it or archive the old parts.

**Evolve, don't ossify.** The structure serves the project, not the other way around. Add directories if your project needs them. Remove files that aren't pulling their weight. The template is a starting point.

## Optional Extensions

Some projects benefit from additional files not in the base template:

- **CLAUDE.md** or **AGENT-CONTEXT.md** — Agent-specific bootstrap instructions or project-relevant personal context. Useful when the project has specific agent behaviors or constraints.
- **PROJECT-INSTRUCTIONS.md** — If using Claude Projects (the web UI), this can hold the canonical copy of custom instructions that get pasted into the UI.
- **thoughts/** — Longer-form thinking documents, explorations that aren't plans yet.
