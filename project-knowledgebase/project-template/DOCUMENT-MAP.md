# Document Map

**Purpose:** Central index of all project files — structure, descriptions, and loading guidance.

---

## Directory Structure

```
<project-name>/
  00-project-brief.md        — Condensed project context. Load this first. (Tier 1)
  02-status.md               — Phase status, TODOs, what's next. (Tier 2A)
  03-decisions.md            — Working decisions & rationale. (Tier 2B)
  04-backlog.md              — Ideas, links, future exploration. (Tier 2C)
  DOCUMENT-MAP.md            — This file. File index and loading strategy.
  ARCHIVE-MAP.md             — Index of archived material. Load only when going back into history.
  plans/                     — Actionable execution docs. Pull in per-topic.
    archive/                 — Completed/superseded plans. Any directory may have an archive/.
  reference/                 — Full-detail research & look-up material. Pull in when in the weeds.
  output/                    — Finished or near-finished deliverables.
    documents/               — Reports, memos, proposals, written deliverables.
    diagrams/                — Flowcharts, org charts, architecture visuals.
    images/                  — Generated images, screenshots, visual assets.
    data/                    — Spreadsheets, CSVs, analysis results, exports.
  ongoing/                   — Operational runbooks. Living docs for recurring processes.
  journal/                   — Historical archives & templates.
  scratch/                   — Working artifacts. Graduate to plans/ or reference/ when complete.
```

## Loading Guide

Context is finite. Load what's relevant, not everything.

### Tier 1 — Always loaded

| Document | Description |
|----------|-------------|
| `00-project-brief.md` | Vision, goals, architecture, current phase. Enough to orient any conversation. |

### Tier 2 — Pull in for working sessions

| Document | When to pull in |
|----------|-----------------|
| `02-status.md` | Any active work — phase status, TODOs, what's next |
| `03-decisions.md` | Implementation work — current decisions with rationale |
| `04-backlog.md` | Planning sessions — ideas, links, future exploration |

### Plans — Pull in per-topic

| Document | When to pull in |
|----------|-----------------|

### Reference — Pull in when you need specifics

Complete, detailed research and reference material. Full output of any research lands here first; summaries derived from it live elsewhere (`output/`, `03-decisions.md`, `plans/`).

| Document | When to pull in |
|----------|-----------------|

### Archive — Only when going back into history

Completed and superseded material lives in `archive/` subdirectories and is indexed in `ARCHIVE-MAP.md`, not here. This map lists live material only.

## Maintenance

When adding a new file to the project, update this document map. When archiving a file, remove its row here and add one to `ARCHIVE-MAP.md`.
