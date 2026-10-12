# Project Knowledge Base Template

A structured directory template for maintaining durable project knowledge that AI agents (and humans) can navigate efficiently. Designed for use with AI coding assistants like Claude Code, but works with any agent that reads files.

## The Problem This Solves

AI agents lose context between conversations. Every new session starts cold. Project knowledge scattered across chat logs, docs, and memory is expensive to re-discover and easy to get wrong.

This template gives each project a small, predictable set of files that an agent can load selectively based on what kind of work is happening — without dumping everything into context at once.

## Setup

These steps assume an agent that can read and write a folder on your computer, such as Claude Code or Cowork. If you work in claude.ai in a browser, where the agent has no access to your local files, use [Alternative Setup: Google Drive or Similar](#alternative-setup-google-drive-or-similar) instead.

### 1. Place the Template

Put this `project-template` directory inside the parent directory where you want your project knowledge base to live. For example:

```
C:\Users\you\Documents\KnowledgeBase\project-template\      (Windows)
/home/you/KnowledgeBase/project-template/                    (Linux)
~/KnowledgeBase/project-template/                            (macOS)
```

The template stays here as a reference. When you (or your agent) start a new project, the agent copies the template directory, renames it, and fills in the files from your conversation.

### 2. Configure Your Agent

Your agent needs to know where KB directories live and how to use them. Add the following to your agent's persistent instructions, replacing `<YOUR_KB_PATH>` with your actual path:

```
My project knowledge base is stored at <YOUR_KB_PATH>.
Each subdirectory is a project KB. The `project-template` directory
contains the blank template — copy it to create a new project KB.
To understand any project, start with its DOCUMENT-MAP.md — it indexes
all files and describes when to load each one.
```

For example, a Windows user with their knowledge base in their Documents folder would use:

```
My project knowledge base is stored at C:\Users\jane\Documents\KnowledgeBase.
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

## Alternative Setup: Google Drive or Similar

When the agent cannot reach a folder on your computer, the knowledge base can live in Google Drive, and the agent reaches it through the Google Drive connector. This is the setup for claude.ai in a browser. The directory structure, the loading tiers, and the file roles are the same as everywhere else in this document. What changes is how files are found, how they are updated, and what format deliverables take.

The KB documents stay plain Markdown in Drive. That keeps them readable by any tool, and it means the same Drive folder can also be synced to a computer and used by a local agent with the instructions in [Setup](#setup).

This section is written for Google Drive. The approach very likely carries over to other cloud storage that has a Claude connector, but working out the details for your service is up to you. The one hard requirement is a connector that can create, rename, and trash files; a read-only connector cannot hold a knowledge base. Replace the connection steps with your service's own, and the Google file types for deliverables with your service's native formats.

### 1. Put the Template in Drive

Create a folder in Google Drive to hold your knowledge base (for example `KnowledgeBase`) and upload this `project-template` folder into it. If you have the template as a zip, unpack it first and upload the folder: Drive stores a zip as a single file and does not unpack it. After the upload, check that the files are still `.md` files and were not converted to Google Docs.

Use the Google account that should own this knowledge, either a personal account or your company's Google Workspace account. The agent signs in as that account and can reach only the files it can open.

### 2. Connect Google Drive

1. In claude.ai, go to **Customize > Connectors**, find **Google Drive**, and select **Connect**.
2. Sign in to the Google account that holds the KB folder and grant the requested permissions. A company account signs in the way it normally does, including through company single sign-on.
3. In each conversation that uses a knowledge base, select **+** in the message box, select **Connectors**, and turn **Google Drive** on. The connection is made once; the toggle is per conversation.

On Team and Enterprise plans, Google Drive does not appear in the connector list until an Owner adds it for the organization. Each member then connects their own Google account. See Anthropic's [Google Drive connector guide](https://claude.com/docs/connectors/google/drive) and [Use Google Workspace connectors](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) for details.

### 3. Configure Your Agent

Add the following to your **Profile Instructions**, or to a **Project's instructions** to scope it to one project, replacing `<YOUR_KB_FOLDER>` with the name of your folder (for example `KnowledgeBase`). Use it in place of the block in [Setup](#2-configure-your-agent), not in addition to it. The agent reads these instructions in every conversation but does not reload this README, so the block carries the working rules in full.

```
My project knowledge base is stored in Google Drive, in the folder
"<YOUR_KB_FOLDER>". Reach it with the Google Drive connector. If more
than one folder has that name, ask me which one. Each sub-folder is one
project's KB. The `project-template` folder contains the blank template;
its README.md explains how to create a new project KB from it.
To understand any project, start with its DOCUMENT-MAP.md, which indexes
all files and describes when to load each one.

If the Google Drive connector is not available in this conversation,
tell me and stop. Do not work from memory or create local files instead.

FINDING AND NAMING FILES
- Refer to KB files by name and path (for example `plans/api-design.md`),
  never by Drive link or file ID. An updated file gets a new ID, so its
  old link stops working.
- Drive allows two items with the same name in one folder. Before you
  create or rename any file or folder, list the destination folder and
  compare names ignoring upper and lower case. If the name is already
  there, do not create a second one: update the existing file, or ask me.
- Create a new file directly under its final name, after that check.

UPDATING A MARKDOWN FILE
The connector cannot change the content of an existing file, so every
edit, however small, replaces the whole file. Collect the changes for one
file into one replacement, then:
1. Read the current file from Drive, in full, right before you change
   it. Make the change in your own working copy.
2. Create the new version in the same folder as `<name>.md.new`, as
   plain Markdown text, not converted to a Google Doc.
3. Read `<name>.md.new` back from Drive and confirm it is complete and
   matches your working copy. If it does not, fix it before going on.
4. Only then move the old `<name>.md` to the trash.
5. Rename `<name>.md.new` to `<name>.md`.
6. List the folder and confirm it holds exactly one `<name>.md` and no
   `.new` file.
I approve the trash in step 4 as part of this procedure. It is the only
time you may trash a KB file without asking me first. To archive or
relocate a file, move it; do not recreate it.

If you find a `.md.new` file you did not just create, an earlier update
was interrupted. If the original is missing, the `.new` file had already
been checked: rename it into place and tell me. If the original is still
there, compare the two and ask me which to keep.

DELIVERABLES
Create finished deliverables under `output/` as native Google files
unless I ask for another format: a Google Doc for a written document, a
Google Sheet for tabular data, Google Slides for a presentation. Change
an existing Google file in place so its link stays the same. If you
cannot edit it in place, tell me instead of creating a second copy.
The KB documents themselves (the top-level files, `plans/`, `reference/`,
`ongoing/`, `journal/`, `scratch/`) stay Markdown.
```

### Why Updates Work This Way

The Drive connector can create, rename, move, and trash a file, but it cannot change the content of a file that already exists. An edit to a Markdown document is therefore a replacement, and the procedure in the block is ordered so that there is never a moment without a complete copy: the new version is written and read back before the old one is touched.

- **Links to KB documents do not survive an update.** The replacement is a new file with a new ID. This is why the block says to refer to files by name and path, which is also how `DOCUMENT-MAP.md` already refers to them.
- **Names are not unique in Drive.** Two files called `02-status.md`, or `02-status.md` and `02-Status.md`, can sit in the same folder, and an agent that finds two cannot tell which is live. The case-insensitive check before every create and rename is what prevents it.
- **Old versions go to Drive's trash.** You can restore them from there until Drive deletes them, 30 days after they were trashed. The agent cannot restore a trashed file itself, which is the reason it checks the new version first.
- **Each update asks for approval three times by default**, once each for the create, the trash, and the rename. Under **Customize > Connectors > Google Drive > Tool permissions**, each tool can be set to **Always allow**, **Needs approval**, or **Blocked**. Allowing create and rename while leaving trash on **Needs approval** cuts this to one prompt per update, at the step that matters. On Team and Enterprise plans, Owners decide whether members may skip approvals.
- **One conversation at a time per file.** Two conversations that update the same document replace each other's work, because each writes back the whole file it read.

### Deliverables as Google Files

Finished deliverables in `output/` default to native Google Docs, Sheets, and Slides, because the people you share them with can open, comment on, and edit them directly in Drive. Unlike the Markdown documents, a native Google file can be changed in place and keeps its link. Editing an existing Google file from the chat is a separate capability from the Drive connector and may not be available in every conversation or plan; where it is not, Drive can still create the file but cannot change it afterward, and the block tells the agent to say so rather than leave you with two copies.

The KB documents themselves are deliberately not Google Docs. Converting Markdown to a Doc and back tends to damage code blocks, tables, and formatting, and it would tie the knowledge base to one vendor's editor.

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
  DOCUMENT-MAP.md        — File index and loading guide (live material only)
  ARCHIVE-MAP.md         — Index of archived material (load only for history)
  plans/                 — Actionable execution plans (per-topic)
    archive/             — Completed/superseded plans (any directory may have one)
  reference/             — Full-detail research, deep dives, technical reference
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

Update this whenever you add or rename a file. It's the table of contents for the live knowledge base; archived material is indexed in `ARCHIVE-MAP.md` instead, so this map stays small.

### ARCHIVE-MAP.md

Index of everything archived: where each item was, where it is now, when and why it was archived, and what superseded it. Agents load it only when going back into the project's history, never as part of normal orientation. The table doubles as the undo list, which matters when the KB is not under version control.

### Archiving

Anything completed, superseded, or otherwise past — a finished plan, a review of merged work, scratch from a closed task — moves into an `archive/` subdirectory beside it: `plans/archive/`, `reviews/archive/`, `scratch/archive/`, and so on. Any directory may have one; create it when first needed. On each move, remove the file's row from `DOCUMENT-MAP.md` and add a row to `ARCHIVE-MAP.md`. Archive rather than delete: archived files cost nothing to keep, and they record why things are the way they are. Delete only what has no value as history, such as regenerable build output or checked-out copies of code.

### plans/

Actionable documents: implementation plans, design specs, feature breakdowns. Each plan is a self-contained document for a specific topic. An agent loads the plan relevant to the current work, not all plans.

Plans that are completed or superseded move to `plans/archive/` (see Archiving).

### reference/

The complete, detailed record: research findings, deep dives, landscape analyses, technical reference material, API documentation. Things you'd look up when you're "in the weeds" on a specific topic.

Reference documents are as complete and detailed as possible. This is the one place in the KB where length is a feature: the point of a reference is that nobody ever has to redo the research. Whenever research is done for a project, especially detailed research, the default is to write the full, completed output here **first**. Summaries, syntheses, and briefs derived from it are produced **afterward**, shaped to the current need, and they are not references, so they do not live here unless you're told otherwise. They go to `output/documents/` (a deliverable), `03-decisions.md` (a decision), `plans/` (a plan), or simply into the conversation.

### ongoing/

Operational runbooks and living process documents — things that describe how to do recurring operations, not one-time plans.

### journal/

Historical archives. When status updates, decision logs, or phase details get long, rotate the old content here, and add a row to `ARCHIVE-MAP.md`. Useful for understanding how the project evolved, but rarely loaded. (Whole files that are past go to an `archive/` subdirectory instead; `journal/` is for content rotated out of the living top-level files.)

### output/

Finished or near-finished deliverables — things the agent produced that you'll use, share, or submit. Organized into subdirectories by type:

- **documents/** — Reports, memos, proposals, analyses, written deliverables. Summaries and syntheses distilled from `reference/` material belong here when they are deliverables. Project-specific outputs like reviews or reports can go here or in their own subdirectory under `output/` — whatever feels natural.
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

1. Create a sibling directory named after the project, and copy in **only the project files**: `00-project-brief.md`, `02-status.md`, `03-decisions.md`, `04-backlog.md`, `DOCUMENT-MAP.md`, `ARCHIVE-MAP.md`, plus the `plans/` and `reference/` directories.
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
5. **Load `ARCHIVE-MAP.md` only when going back into history** — something past is referenced, or the question is how the project got here. Archived files are otherwise out of scope, and searches can skip them (e.g. `grep --exclude-dir=archive`).
6. **Don't load everything.** The whole point is selective loading. If you're answering a quick question, the brief is probably enough.

### Writing Back

When you produce knowledge worth keeping:
- Implementation plans go in `plans/`.
- Research, deep dives, and investigations go in `reference/` **in full, as the first write** — before any summary exists. Then synthesize or summarize for the need at hand. The synthesis goes to `output/`, `03-decisions.md`, `plans/`, or the conversation — never to `reference/` unless directed otherwise.
- Finished deliverables go in `output/` (documents, diagrams, images, data as appropriate).
- Decisions go in `03-decisions.md` (brief entry) with detailed analysis linked from `plans/` or `reference/`.
- Update `DOCUMENT-MAP.md` when adding new files.
- When something is past, archive it (see Archiving): move it to the `archive/` beside it, drop its `DOCUMENT-MAP.md` row, add an `ARCHIVE-MAP.md` row.
- Update `02-status.md` when phase status changes.
- Use `scratch/` for intermediate work that might graduate later.
- If the KB lives in Google Drive or similar cloud storage, follow the update procedure and deliverable formats in [Alternative Setup: Google Drive or Similar](#alternative-setup-google-drive-or-similar).

## Design Principles

**Files are the source of truth.** Not chat logs, not memory systems, not databases. Files on disk that any tool can read.

**Predict where things go.** Anyone (human or agent) should be able to guess where a piece of information lives without consulting an index. Plans are in `plans/`. Decisions are in `03-decisions.md`. Reference material is in `reference/`.

**Concise over comprehensive.** Every file should be as short as it can be while remaining useful. If a document is getting long, split it or archive the old parts. `reference/` is the deliberate exception: a reference is as complete as possible, and the conciseness lives in the summaries derived from it.

**Evolve, don't ossify.** The structure serves the project, not the other way around. Add directories if your project needs them. Remove files that aren't pulling their weight. The template is a starting point.

## Optional Extensions

Some projects benefit from additional files not in the base template:

- **CLAUDE.md** or **AGENT-CONTEXT.md** — Agent-specific bootstrap instructions or project-relevant personal context. Useful when the project has specific agent behaviors or constraints.
- **PROJECT-INSTRUCTIONS.md** — If using Claude Projects (the web UI), this can hold the canonical copy of custom instructions that get pasted into the UI.
- **thoughts/** — Longer-form thinking documents, explorations that aren't plans yet.
