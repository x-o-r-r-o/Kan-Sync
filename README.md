# Kan Sync for Obsidian

> Sync your Obsidian checklists with [Kan.bn](https://kan.bn) kanban boards — view boards in a sidebar, push note checklists as cards, and pull execution status back into your notes.

[Kan.bn](https://kan.bn) is the open-source alternative to Trello. This plugin turns any Obsidian note with checkboxes into a live kanban board and keeps the two in sync — without ever duplicating your board data locally.

![Version](https://img.shields.io/badge/version-0.5.1-blue) ![Obsidian](https://img.shields.io/badge/Obsidian-1.0.0%2B-purple) ![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [Usage Guide](#usage-guide)
- [Sync Conventions](#sync-conventions)
- [Data & Privacy](#data--privacy)
- [API Endpoints Used](#api-endpoints-used)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Development](#development)
- [License](#license)

---

## Features

- **📋 Sidebar board view with drag & drop** — browse any Kan board inside Obsidian: lists as columns, cards with due dates and coloured labels. **Drag cards between lists** to move them in Kan. Always fetched live, never stale.
- **⬆️ Push checklists to Kan** — one command turns the active note's checkboxes into kanban cards. Headings become lists, unchecked items become cards.
- **⬇️ Pull board status into notes** — writes a status table into your note and auto-checks off items whose cards reached a "Done" list.
- **🔗 Rename-safe sync (ID markers)** — synced items get a hidden `%%kan:ID%%` Obsidian comment (invisible in Reading mode). Rewording an item **updates** its card instead of duplicating it.
- **📅 Due dates** — write `📅 2026-08-14` or `@due(2026-08-14)` on an item and the card gets a due date; changing it updates the card.
- **🏷 #tags → labels** — tags on checklist items become Kan labels, auto-created with deterministic colours.
- **☑️ Sub-items → card checklists (two-way)** — indented checkboxes under an item become a checklist on its card. Completion flows both ways: check a sub-item in the note and Kan's checklist item completes on push; complete it in Kan and the note checks off on pull.
- **📎 Attachments** — attach any file (up to 50 MB) or the active note itself to a synced card, straight from the editor. Attachment counts show on cards in the board view.
- **👤 @mentions → assignees** — write `@asim` on an item and the matching workspace member (by name or email prefix) is assigned to the card. Add-only.
- **🗂 Card detail modal** — click any card in the board view: full description, labels, members, checklists with progress, attachment download links, activity feed (moves, renames, labels, members), and inline commenting.
- **🌐 Multi-workspace switcher** — a workspace dropdown in the board view header; switch workspaces without touching settings.
- **🏷️ Retro-labeling** — add a #tag to an already-synced item and the label lands on its card on next push (add-only; never removes).
- **✅ Done items move cards** — check off an item in the note and its card moves to your first "Done" list on next push.
- **💬 Card comments** — comment on any synced card straight from the editor (cursor on the line → command).
- **🔎 Workspace search** — fuzzy-search all boards and cards; selecting a result opens its board in the sidebar.
- **↕️ In-list reordering** — drop a card onto another card to take its position.
- **🔄 Full sync command** — push + pull in one step.
- **⏱ Auto-sync** — optional interval that auto-pulls status for notes opted in via `kan_board` frontmatter.
- **🔁 Idempotent** — dedupe by ID marker (or title fallback); pushing twice never duplicates, and the plugin **never deletes** cards.
- **🗂 Frontmatter board mapping** — a note syncs to a board with the same name; override with `kan_board:` frontmatter.
- **🔐 Local-first credentials** — your API key lives only in your vault's plugin folder, never transmitted anywhere except your Kan instance.
- **☁️ Self-hosted support** — configurable API base URL in settings.

## How It Works

**Your boards live on Kan's servers — the plugin is a live API bridge, not a local database.**

```
┌─────────────────────┐         REST API          ┌──────────────┐
│  Obsidian (vault)   │ ◄───────────────────────► │   Kan.bn     │
│                     │                           │              │
│  Notes = the PLAN   │  Push: checklist → cards  │ Boards = the │
│  (what needs doing) │  Pull: card status → ☑    │  EXECUTION   │
│                     │  View: live board render  │ (progress)   │
└─────────────────────┘                           └──────────────┘
```

The design follows a single-source-of-truth rule to avoid two-way edit conflicts:

| Data | Source of truth | Flow |
|------|-----------------|------|
| Plans, checklists, task wording | Obsidian notes | Vault → Kan (push) |
| Execution state (in progress / done) | Kan board | Kan → vault (pull) |

Nothing runs in the background — push and pull only happen when you run a command. The board view fetches fresh data every time it renders.

## Installation

### Manual (current method)

1. Download/copy the plugin folder to your vault:
   ```
   <your-vault>/.obsidian/plugins/kan-sync/
   ├── manifest.json
   ├── main.js
   └── styles.css
   ```
2. Reload Obsidian (`Ctrl/Cmd + R`)
3. **Settings → Community plugins** → turn off Restricted mode if prompted → enable **Kan Sync**

### Via BRAT (if you publish this repo)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add this repository's URL as a beta plugin
3. Enable **Kan Sync** in Community plugins

## Configuration

Open **Settings → Kan Sync**:

Settings are grouped into **Connection**, **Push (note → Kan)**, and **Pull (Kan → note)**:

| Setting | Group | Description | Default |
|---------|-------|-------------|---------|
| **API key** | Connection | Create at [kan.bn/settings](https://kan.bn/settings) → API keys. Stored locally in `data.json` | — |
| **Base URL** | Connection | Kan API base — change for self-hosted instances | `https://kan.bn/api/v1` |
| **Workspace** | Connection | Your Kan workspace public ID. Click **Detect** to auto-fill (first workspace selected; others logged to console) | — |
| **Rename-safe ID markers** | Push | Hidden `%%kan:ID%%` comments so renames update cards instead of duplicating | On |
| **Sync #tags as labels** | Push | Item tags become auto-created Kan labels | On |
| **Sync @mentions as card members** | Push | `@name` assigns matching workspace members to cards (add-only) | On |
| **Retro-label existing cards** | Push | Tags added to already-synced items label their cards on next push (add-only) | On |
| **Sync sub-items as card checklists** | Push | Indented checkboxes become a checklist on the card | On |
| **Subtask checklist name** | Push | Name of the card checklist receiving sub-items | `Subtasks` |
| **Move done cards** | Push | Items checked in the note move their cards to the first Done list | On |
| **Default list name** | Push | List for items appearing before any heading | `Backlog` |
| **Done lists** | Pull | Comma-separated list names treated as "completed" | `Done, Completed, Launched` |
| **Status section heading** | Pull | Heading for the status section written into notes | `## Kan Board Status` |
| **Include card titles in status** | Pull | Off = counts only (compact tables) | On |
| **Auto-sync interval (minutes)** | Pull | `0` = off. Auto-pulls for active notes with `kan_board` frontmatter | `0` |

## Commands

All commands are available via the Command Palette (`Ctrl/Cmd + P`):

| Command | What it does |
|---------|--------------|
| `Kan Sync: Open board view` | Opens the sidebar kanban view (also via the ribbon dashboard icon). Board selector, refresh, drag & drop between lists |
| `Kan Sync: Push active note's checklist to Kan` | Parses the active note, finds/creates the matching board, creates lists from headings and cards from unchecked items; updates renamed titles and due dates on marked items |
| `Kan Sync: Pull Kan board status into active note` | Fetches the matching board, writes/updates a `## Kan Board Status` section, checks off items completed in Kan (matched by ID marker, title fallback) |
| `Kan Sync: Full sync active note (push + pull)` | Both of the above in one step |
| `Kan Sync: Search boards and cards` | Fuzzy search across the workspace (also via 🔍 in the board view); choosing a result opens its board |
| `Kan Sync: Comment on linked card (cursor line)` | With the cursor on a synced item (`%%kan:ID%%` present), opens a comment box and posts to the card |
| `Kan Sync: Attach a file to linked card (cursor line)` | Opens a file picker; uploads the chosen file (≤50 MB) to the card via presigned S3 upload |
| `Kan Sync: Attach active note to linked card (cursor line)` | Uploads the current note as a `.md` attachment on the card — snapshot the plan onto the board |

## Usage Guide

### 1. Structure your note

```markdown
---
kan_board: Reminda AI Launch   # optional — defaults to the note's name
---

## Phase 1 — Foundation
- [ ] Lock the launch date 📅 2026-07-20 #P0
- [ ] Finalize positioning & core message #P1
- [x] Already done item        # skipped on push

## Phase 2 — Assets
- [ ] Ad creatives batch 1 @due(2026-07-27) #P1 #marketing
- [ ] Social accounts set up
```

### 2. Push

Run **Push active note's checklist to Kan**:

- Board `Reminda AI Launch` is found — or created if missing
- `Phase 1 — Foundation` and `Phase 2 — Assets` become lists (created if missing)
- Each unchecked item becomes a card with its due date and tag-labels (existing cards skipped/updated)
- After creation, each line gains a hidden `%%kan:ID%%` marker linking it to its card — subsequent pushes **update** the card (title, due date) instead of duplicating
- Checked items are ignored
- Cards get a description linking back to the source note path

### 3. Work the board

Drag cards between lists in Kan (web/self-hosted UI) — alone or with your team. Obsidian stays untouched.

### 4. Pull

Run **Pull Kan board status into active note**:

- A `## Kan Board Status` section is written (or replaced) with a table of lists, card counts, and titles
- Any card sitting in a list named in **Done lists** gets its matching `- [ ]` checkbox flipped to `- [x]` in your note

### Checklist parsing rules

- Headings `##` to `####` start a new list; items before any heading go to the **Default list** (`Backlog`)
- Only `- [ ]` / `- [x]` items are parsed; code blocks are ignored
- **Indented checkboxes** under an item become checklist items on its card (`Subtasks` checklist)
- `📅 YYYY-MM-DD` or `@due(YYYY-MM-DD)` on an item → card due date
- `#tags` on an item → Kan labels (auto-created, deterministic colour)
- `@name` on an item → card assignee (matched against workspace member names / email prefixes)
- `%%kan:ID%%` markers link lines to cards (added automatically; hidden in Reading mode)
- Markdown formatting is stripped from card titles: `**bold**`, `[[wikilinks]]`, `[links](url)`, `` `code` ``, dates, tags, markers
- Card titles are capped at 2,000 characters (API limit)

## Sync Conventions

- **Dedupe key = ID marker** when present; **title** (case-insensitive, formatting-stripped) as fallback for unmarked lines. With markers on (default), rewording an item **renames** its card on next push.
- **No deletions, ever.** The plugin only creates and updates. Removing cards is always a manual action in Kan.
- **One board per note.** Big projects = one note with phases as headings, or several notes each mapped via `kan_board`.
- **Labels attach at card creation.** Adding a tag to an already-synced item does not retro-label the card (planned).

## Data & Privacy

| Data | Where it lives |
|------|----------------|
| Boards, lists, cards | Kan's servers (or your self-hosted instance) — never mirrored locally |
| API key, workspace ID, settings | `<vault>/.obsidian/plugins/kan-sync/data.json` (plaintext, local) |
| Status snapshots | Only in notes where you explicitly run Pull |

The plugin makes HTTPS requests exclusively to `kan.bn` (or your configured instance). No telemetry, no third parties.

> ⚠️ If you sync your vault (Obsidian Sync, iCloud, git), `data.json` — including your API key — syncs with it. Add it to `.gitignore` for public repos.

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/workspaces` | GET | Detect workspace (response unwrapped from `{role, workspace}` items) |
| `/workspaces/{id}/boards` | GET | List boards for the board view & name matching |
| `/workspaces/{id}/boards` | POST | Create board (with initial lists) on first push |
| `/boards/{id}` | GET | Full board fetch: lists → cards → labels/due dates/checklists |
| `/lists` | POST | Create missing lists on push |
| `/cards` | POST | Create cards from checklist items (with due date + labels) |
| `/cards/{id}` | PUT | Rename cards, update due dates, move between lists, reorder (index) |
| `/cards/{id}/labels/{labelId}` | PUT | Retro-label synced cards |
| `/cards/{id}/comments` | POST | Comment on cards from the editor |
| `/cards/{id}/checklists` | POST | Create Subtasks checklist from indented items |
| `/checklists/{id}/items` | POST | Add sub-items to card checklists |
| `/workspaces/{id}/search` | GET | Fuzzy search boards & cards |
| `/labels` | POST | Auto-create labels from #tags |
| `/checklists/items/{id}` | PATCH | Two-way sub-item completion |
| `/cards/{id}/attachments/upload-url` | POST | Presigned S3 URL for attachment upload |
| `/cards/{id}/attachments/confirm` | POST | Save uploaded attachment to the card |
| `/cards/{id}` | GET | Card detail modal (description, checklists, attachments, members, activity) |
| `/cards/{id}/members/{memberId}` | PUT | Assign members from @mentions |
| `/cards/{id}/activities` | GET | Activity feed pagination (modal uses embedded activities by default) |

Full API docs: [docs.kan.bn/api-reference](https://docs.kan.bn/api-reference/introduction)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No API key set" | Settings → Kan Sync → paste key from kan.bn/settings |
| Detect shows "No workspaces found" | Key invalid or account has no workspace — test the key: `curl -H "Authorization: Bearer kan_..." https://kan.bn/api/v1/workspaces` |
| `Kan API 401/403` | Key missing/revoked — create a new one |
| Board view empty | Check workspace ID is set; hit the ↻ refresh button |
| Pushed items missing | Items must be `- [ ]` (unchecked); checked items are skipped by design |
| Duplicate cards after rewording | Expected — dedupe is title-based. Archive the old card in Kan |
| Plugin not listed after install | Reload Obsidian; confirm the three files sit in `.obsidian/plugins/kan-sync/` directly (no nested folder) |

Errors are also logged to the developer console (`Ctrl/Cmd + Shift + I`).

## Limitations

- Completion, label, and member sync are all **additive** — checking/tagging/mentioning adds, but removing never removes on the other side (prevents sync ping-pong; remove manually where needed)
- Auto-sync pulls only (status → note); pushes remain manual by design (vault owns the plan — pushing automatically on every edit would create half-finished cards)
- Card detail modal is read-mostly: commenting works inline; editing title/description happens in Kan's UI
- `@mention` matching needs the person's workspace name or email prefix; unmatched mentions are logged to the console, never guessed

## Roadmap

- [x] ~~Card↔item ID mapping for rename-safe sync~~ — v0.2.0 (`%%kan:ID%%` markers)
- [x] ~~Configurable base URL for self-hosted Kan~~ — v0.2.0
- [x] ~~Drag & drop cards in the board view~~ — v0.2.0
- [x] ~~Per-card due dates from `📅 YYYY-MM-DD` syntax~~ — v0.2.0 (also `@due(...)`)
- [x] ~~Label mapping from `#tags`~~ — v0.2.0
- [x] ~~Auto-sync interval option~~ — v0.2.0 (opt-in via `kan_board` frontmatter)
- [x] ~~Retro-label cards when tags change on synced items~~ — v0.3.0
- [x] ~~Card reordering within lists (drag & drop index)~~ — v0.3.0
- [x] ~~Sub-items → card checklists~~ — v0.3.0
- [x] ~~Workspace search~~ — v0.3.0
- [x] ~~Card comments from the editor~~ — v0.3.0
- [x] ~~Done items move cards to Done list~~ — v0.3.0
- [x] ~~Two-way sub-item completion (note → Kan checklist items)~~ — v0.4.0
- [x] ~~Card attachments (files + note snapshots)~~ — v0.4.0
- [x] ~~Member/assignee sync (`@person` syntax)~~ — v0.5.0
- [x] ~~Card detail modal (description, comments, activity) in board view~~ — v0.5.0
- [x] ~~Multi-workspace switcher in board view~~ — v0.5.0

## Changelog

### 0.5.0
- `@mention` member sync: assigns matching workspace members to cards on push (name or email-prefix matching, add-only, unmatched logged)
- Card detail modal: click a card → description, labels, members, checklists, attachment download links, activity feed, inline commenting
- Multi-workspace switcher in the board view header
- 👤 assignee names shown on cards in board view
- `versions.json` added for community store readiness

### 0.4.0
- Two-way sub-item completion: checked sub-items in the note complete their Kan checklist items on push (`PATCH /checklists/items/{id}`); additive both ways
- Attachments: attach any file (≤50 MB, presigned S3 flow) or the active note as `.md` to a synced card, from the editor
- 📎 attachment count badges on cards in the board view
- Sync notice now reports completed subtasks

### 0.3.0
- Sub-items (indented checkboxes) sync to card checklists; completed checklist items check off in the note on pull
- Retro-labeling: tags added to synced items label their cards (add-only)
- Done items in the note move their cards to the first Done list on push
- Card comments from the editor (command on marked lines)
- Workspace-wide fuzzy search (command + 🔍 button); results open their board
- Drag & drop reordering within a list (drop on a card)
- Checklist progress (☑ n/m) shown on cards in board view
- Settings reorganized into Connection / Push / Pull groups with 7 new options

### 0.2.0
- Drag & drop between lists in board view
- Rename-safe sync via hidden `%%kan:ID%%` markers (+ auto-linking of existing cards)
- Due dates (`📅` / `@due()`) pushed and updated
- `#tags` → auto-created coloured Kan labels
- `Full sync` command (push + pull)
- Auto-sync interval (opt-in per note via `kan_board` frontmatter)
- Configurable base URL for self-hosted Kan
- Label colours rendered in board view

### 0.1.1
- Fix: workspace detection (unwrap `{role, workspace}` response shape)

### 0.1.0
- Initial release: board view, push checklist, pull status

## Development

Plain JavaScript, no build step — `main.js` is the plugin. To hack on it:

1. Edit `main.js`
2. Reload Obsidian (or use the [Hot Reload](https://github.com/pjeby/hot-reload) plugin)
3. `node --check main.js` for a quick syntax gate

PRs and issues welcome.

## License

MIT © [x-o-r-r-o](https://github.com/x-o-r-r-o/)

*Kan.bn itself is [AGPL-3.0](https://github.com/kanbn/kan) — this plugin is an independent API client and is not affiliated with the Kan team.*
