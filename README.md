# Kan Sync for Obsidian

> Sync your Obsidian checklists with [Kan.bn](https://kan.bn) kanban boards — view boards in a sidebar, push note checklists as cards, and pull execution status back into your notes.

[Kan.bn](https://kan.bn) is the open-source alternative to Trello. This plugin turns any Obsidian note with checkboxes into a live kanban board and keeps the two in sync — without ever duplicating your board data locally.

![Version](https://img.shields.io/badge/version-0.7.2-blue) ![Obsidian](https://img.shields.io/badge/Obsidian-1.0.0%2B-purple) ![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [Complete usage guide](#complete-usage-guide)
- [Sync Conventions](#sync-conventions)
- [Disclosures](#disclosures)
- [Data & Privacy](#data--privacy)
- [API Endpoints Used](#api-endpoints-used)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Changelog](#changelog)
- [Development](#development)
- [License](#license)

---

## Features

- **Full Kan API coverage (v0.7.x)** — board filters/templates/archive, card editing, workspace admin, invites, permissions, webhook management, Trello/GitHub import; slug resolve, named checklists, label colour sync.
- **Sidebar board view with drag & drop** — browse any Kan board inside Obsidian; drag cards between lists or reorder within a list. Filter by due date, label, or member.
- **Push checklists to Kan** — headings become lists; unchecked items become cards.
- **Pull board status into notes** — status table + auto-check completed items; optionally enrich lines with due dates, `#tags`, and `@mentions` from Kan.
- **Rename-safe sync (ID markers)** — hidden `%%kan:ID%%` comments so rewording updates the same card.
- **Due dates** — `📅 2026-08-14` or `@due(2026-08-14)`; clearing the date on a note clears the card due date on push.
- **`#tags` → labels** — auto-created with deterministic colours; retro-label existing cards; optional remove when deletes are enabled.
- **`@mentions` → assignees** — matched by workspace member name or email prefix; set on card create.
- **Card descriptions** — indented text under an item (not a sub-checkbox) syncs to the card description.
- **Sub-items → card checklists** — two-way completion; optional delete of removed sub-items.
- **Attachments** — attach a file or the active note to a synced card.
- **Card detail modal** — description, labels, members, checklists, attachments, activity, inline comments.
- **Multi-workspace switcher** — switch workspaces from the board view header.
- **Board & list rename** — renaming the note / `kan_board` or a heading can rename the Kan board / list on push.
- **Optional deletes** — opt-in removal of cards, labels, members, and checklist items that disappear from the note.
- **Duplicate / delete card commands** — from the cursor line (delete requires optional deletes).
- **Workspace search**, **comments**, **done-item → Done list**, **auto-sync pull**, **self-hosted base URL**.

## How It Works

**Your boards live on Kan's servers — the plugin is a live API bridge, not a local database.**

```
┌─────────────────────┐         REST API          ┌──────────────┐
│  Obsidian (vault)   │ ◄───────────────────────► │   Kan.bn     │
│                     │                           │              │
│  Notes = the PLAN   │  Push: checklist → cards  │ Boards = the │
│  (what needs doing) │  Pull: status + meta → ☑  │  EXECUTION   │
│                     │  View: live board render  │ (progress)   │
└─────────────────────┘                           └──────────────┘
```

| Data | Source of truth | Flow |
|------|-----------------|------|
| Plans, checklists, task wording, descriptions | Obsidian notes | Vault → Kan (push) |
| Execution state (in progress / done) | Kan board | Kan → vault (pull) |
| Due dates, labels, members (when pull options on) | Kan board (enriched into note) | Kan → vault (pull) |

Nothing runs in the background except optional auto-pull. Push and pull only run when you invoke a command (or auto-sync tick).

## Installation

### Community plugins (recommended)

1. **Settings → Community plugins** → turn off Restricted mode if prompted
2. Browse / search for **Kan Sync**
3. Install and enable

Also listed at [community.obsidian.md](https://community.obsidian.md).

### Manual

1. Download the latest release from [GitHub Releases](https://github.com/x-o-r-r-o/Kan-Sync/releases) (`manifest.json`, `main.js`, `styles.css`)
2. Copy them into:
   ```
   <your-vault>/.obsidian/plugins/kan-sync/
   ├── manifest.json
   ├── main.js
   └── styles.css
   ```
3. Reload Obsidian (`Ctrl/Cmd + R`) and enable **Kan Sync** under Community plugins

### Via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add `https://github.com/x-o-r-r-o/Kan-Sync` as a beta plugin
3. Enable **Kan Sync** in Community plugins

## Configuration

Open **Settings → Kan Sync**.

### Connection

| Setting | Description | Default |
|---------|-------------|---------|
| **API key** | Create at [kan.bn/settings](https://kan.bn/settings) → API keys | — |
| **Base URL** | Change for self-hosted Kan | `https://kan.bn/api/v1` |
| **Workspace** | Workspace public ID — use **Detect** to auto-fill | — |

### Push (note → Kan)

| Setting | Description | Default |
|---------|-------------|---------|
| **Rename-safe ID markers** | Append `%%kan:ID%%` after sync | On |
| **Sync #tags as labels** | Tags → Kan labels | On |
| **Retro-label existing cards** | Add labels when tags appear on synced items | On |
| **Sync @mentions as card members** | `@name` → assignees | On |
| **Sync card descriptions** | Indented text under an item → card description | On |
| **Rename board to match note** | Rename Kan board when note / `kan_board` changes; writes `kan_board_id` | On |
| **Rename lists to match headings** | Rename Kan list when a heading changes | On |
| **Allow deletes on push** | Remove Kan cards/labels/members/subtasks that disappear from the note | **Off** |
| **Sync sub-items as card checklists** | Indented checkboxes → checklist | On |
| **Subtask checklist name** | Checklist name on the card | `Subtasks` |
| **Move done cards** | Checked note items move cards to first Done list | On |
| **Default list name** | List for items before any heading | `Backlog` |

### Pull (Kan → note)

| Setting | Description | Default |
|---------|-------------|---------|
| **Pull due dates** | Write `📅 YYYY-MM-DD` from the card | On |
| **Pull labels as #tags** | Write card labels as `#tags` | On |
| **Pull members as @mentions** | Write members as `@handles` | On |
| **Done lists** | List names treated as completed | `Done, Completed, Launched` |
| **Status section heading** | Heading for the status table | `## Kan Board Status` |
| **Include card titles in status** | Off = counts only | On |
| **Auto-sync interval (minutes)** | `0` = off; auto-pull when note has `kan_board` frontmatter | `0` |

## Commands

All via Command Palette (`Ctrl/Cmd + P`):

| Command | What it does |
|---------|--------------|
| `Kan Sync: Open board view` | Sidebar kanban (also ribbon dashboard icon) |
| `Kan Sync: Push active note's checklist to Kan` | Create/update board, lists, cards from the note |
| `Kan Sync: Pull Kan board status into active note` | Status table + checkoffs + optional due/tags/mentions |
| `Kan Sync: Full sync active note (push + pull)` | Push then pull |
| `Kan Sync: Search boards and cards` | Fuzzy search (also 🔍 in board view) |
| `Kan Sync: Comment on linked card (cursor line)` | Comment on the card for the current line |
| `Kan Sync: Attach a file to linked card (cursor line)` | Upload a file (≤50 MB) |
| `Kan Sync: Attach active note to linked card (cursor line)` | Attach current note as `.md` |
| `Kan Sync: Duplicate linked card (cursor line)` | Duplicate the card in its list |
| `Kan Sync: Delete linked card (cursor line)` | Delete card in Kan (requires **Allow deletes on push**) |
| `Kan Sync: Open Kan Sync settings (admin)` | Jump to Settings → Kan Sync |
| `Kan Sync: Show Kan instance stats` | Fetch `/stats` (console + notice) |
| `Kan Sync: Lookup invite code` | Resolve an invite code via the API |

Admin-only board/workspace commands (archive, favorite, templates, import, invite) are also in the palette — see Changelog.

## Complete usage guide

### 1. Connect once

1. Install and enable **Kan Sync**.
2. Open **Settings → Kan Sync**.
3. Paste your API key from [kan.bn/settings](https://kan.bn/settings).
4. Click **Detect** next to Workspace (or paste a workspace public ID).
5. Leave Base URL as default unless you self-host.

### 2. Write a plan note

Use normal Markdown checklists. Headings (`##`–`####`) become Kan lists.

```markdown
---
kan_board: Reminda AI Launch
---

## Phase 1 — Foundation
- [ ] Lock the launch date 📅 2026-07-20 #P0 @asim
  Confirm with leadership and freeze the calendar.
  - [ ] Draft announcement
  - [ ] Book venue
- [ ] Finalize positioning & core message #P1
- [x] Already done item

## Phase 2 — Assets
- [ ] Ad creatives batch 1 @due(2026-07-27) #marketing
```

**Frontmatter**

| Key | Purpose |
|-----|---------|
| `kan_board` | Board name (defaults to the note file name) |
| `kan_board_id` | Written automatically on first push — keeps the link if you rename the board/note |
| `kan_board_slug` | Written on push/pull when the board has a slug; used with workspace slug for lookup |
| `kan_workspace_slug` | Optional; also filled from Settings → Workspace slug |
| `kan_template_id` | Create/link from a template board |
| `kan_labels` | Seed label names when creating a new board |

**Line syntax**

| Syntax | Effect on push |
|--------|----------------|
| `- [ ]` / `- [x]` | Card (unchecked create/update; checked can move to Done) |
| `## Heading` | List name |
| `📅 YYYY-MM-DD` or `@due(YYYY-MM-DD)` | Card due date; **remove it** to clear the due date on push |
| `#tag` | Kan label |
| `@name` | Card member (workspace name / email prefix) |
| Indented text (not a checkbox) | Card description body |
| Indented `### ChecklistName` | Named checklist on the card (items below use that name) |
| Indented `- [ ]` | Checklist item on the card (default name: Subtasks) |
| `%%kan:ID%%` | Link to an existing card (added automatically) |

### 3. Push

1. Open the note.
2. Run **Kan Sync: Push active note's checklist to Kan**.
3. The plugin finds or creates the board, ensures lists, creates/updates cards, and appends `%%kan:ID%%` markers.
4. Open **Kan Sync: Open board view** to see the live board; drag cards to move them in Kan.

### 4. Work in Kan

Move cards, add labels/members/due dates in Kan (web or self-hosted). Collaborators can edit the board while your note remains the plan source.

### 5. Pull

1. Run **Kan Sync: Pull Kan board status into active note**.
2. Items whose cards sit in a **Done** list get checked off.
3. With pull options on, each linked line is enriched with `📅`, `#tags`, and `@mentions` from the card.
4. A `## Kan Board Status` table is written/updated at the bottom (or your custom heading).

### 6. Full sync

**Kan Sync: Full sync active note (push + pull)** — push plan changes, then pull execution state.

### 7. Descriptions and named checklists

```markdown
- [ ] Ship docs #P1
  Audience: new self-hosters.
  Include Docker Compose and MinIO notes.
  ### Writing
  - [ ] Outline
  - [ ] Screenshots
  ### Review
  - [ ] Peer review
```

On push, the card description becomes:

```
From Obsidian: path/to/note.md

Audience: new self-hosters.
Include Docker Compose and MinIO notes.
```

Indented `###` headings under a card create named Kan checklists; sub-item renames and order are pushed when titles change or items move.
### 8. Board and list rename

- Change `kan_board` (or rename the note if you rely on the basename) → next **push** renames the Kan board when **Rename board to match note** is on.
- Rename a `##` heading whose cards already have markers → next **push** renames that Kan list when **Rename lists to match headings** is on.

### 9. Optional deletes (off by default)

Enable **Allow deletes on push**, then on the next push:

- Tags removed from a line → labels removed from the card
- `@mentions` removed → members removed
- Sub-checkboxes removed → checklist items deleted
- Entire synced items removed from the note → cards whose description starts with `From Obsidian: <this note path>` are deleted

You can also run **Delete linked card (cursor line)** with the cursor on a marked item.

### 10. Comments, attachments, duplicate

- Cursor on a marked line → **Comment on linked card**
- **Attach a file** / **Attach active note**
- **Duplicate linked card** creates a copy in the same list

### 11. Auto-sync

Set **Auto-sync interval** to e.g. `15`. Only notes with `kan_board` in frontmatter auto-**pull** while active. Pushes stay manual so half-written plans are not pushed.

### 12. Self-hosted Kan

Set **Base URL** to your instance’s API root (usually ending in `/api/v1`). Everything else is the same.

## Sync Conventions

- **Dedupe key = ID marker** when present; **title** (case-insensitive, formatting-stripped) as fallback. With markers on, rewording an item **renames** its card on next push.
- **No deletions by default.** Enable **Allow deletes on push** to remove cards/labels/members/subtasks that disappear from the note.
- **One board per note.** Use headings for phases, or multiple notes each with `kan_board` / `kan_board_id`.
- **Labels attach at creation and via retro-label.** Adding a `#tag` to an already-synced item labels the card on next push when **Retro-label** is on.
- **Clearing a due date** in the note clears `dueDate` on the card on push.
- **Pull enrichment** rewrites due/`#tags`/`@mentions` on linked lines from Kan (title text is preserved; meta is rebuilt).
- **Vault owns the plan; Kan owns execution** — avoid editing the same field on both sides in the same sync cycle.

## Disclosures

This section covers items the [community scorecard](https://community.obsidian.md/plugins/kan-sync#scorecard) surfaces, per [Obsidian developer policies](https://docs.obsidian.md/Developer+policies). Also see [`SECURITY.md`](./SECURITY.md).

### Account required

A [Kan.bn](https://kan.bn) account (or an account on your self-hosted Kan instance) and an API key are required for the plugin to function. There is no separate Kan Sync account.

### Payment

No payment is required for this plugin. Kan.bn or your self-hosted host may have their own plans; this plugin has no in-app purchases.

### Network use

All remote HTTP uses Obsidian’s `requestUrl()` API (three call sites in `main.js`):

1. **Kan REST API** — `GET`/`POST`/`PUT`/`PATCH`/`DELETE` to your configured **Base URL** (default `https://kan.bn/api/v1`) with your API key in the `Authorization` header. Used for boards, lists, cards, labels, members, search, comments, checklists, webhooks admin, imports, etc.
2. **Presigned attachment upload** — `PUT` of file bytes to a short-lived URL returned by Kan (typically S3-compatible object storage). The upload request does **not** include your API key.
3. **Attachment download** — `GET` of an attachment URL when saving an attachment into the vault from the card modal.

No other remote hosts are contacted by default. Changing **Base URL** (self-hosted) redirects all Kan API traffic to that host. Optional **Open authorization URL** for Trello/GitHub import opens a browser tab to the URL Kan returns (user-initiated).

Optional **auto-sync pull** (off by default) schedules a silent pull for the active note when `kan_board` frontmatter is set. It uses a one-shot timer only while the interval setting is &gt; 0 — not a permanent background poller.

### Clipboard access

The plugin **writes** invite links / codes to the system clipboard when you use **Copy workspace invite link** (and the matching Settings button). The clipboard is never read.

### Vault access

Reads and writes Markdown notes via the Obsidian vault API (`vault.read` / `vault.modify`, frontmatter helpers). Does not access files outside the vault.

### Telemetry

No analytics, crash reporters, or third-party telemetry. Traffic is only to your Kan API base and Kan-issued upload/download URLs.

### Webhooks

Settings can create/update/test/delete Kan webhook endpoints. Obsidian cannot receive inbound HTTP; live event→vault sync needs an external relay.

## Data & Privacy

| Data | Where it lives |
|------|----------------|
| Boards, lists, cards | Kan's servers (or your self-hosted instance) |
| API key, workspace ID, settings | `<vault>/.obsidian/plugins/kan-sync/data.json` |
| Status snapshots / enriched lines | In notes when you pull |
| Attachment file bytes | Kan-issued presigned storage URLs |

> If you sync your vault (Obsidian Sync, iCloud, git), `data.json` — including your API key — syncs with it. Add it to `.gitignore` for public repos.

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/workspaces` | GET | Detect workspace |
| `/workspaces/{id}/boards` | GET / POST | List / create boards |
| `/boards/{id}` | GET / PUT | Fetch / rename board |
| `/lists` | POST | Create lists |
| `/lists/{id}` | PUT | Rename / reorder lists |
| `/cards` | POST | Create cards (labels + members) |
| `/cards/{id}` | GET / PUT / DELETE | Detail, update, delete |
| `/cards/{id}/duplicate` | POST | Duplicate card |
| `/cards/{id}/labels/{labelId}` | PUT | Toggle label |
| `/cards/{id}/members/{memberId}` | PUT | Toggle member |
| `/cards/{id}/comments` | POST | Comment |
| `/cards/{id}/checklists` | POST | Create checklist |
| `/checklists/{id}/items` | POST | Add checklist item |
| `/checklists/items/{id}` | PATCH / DELETE | Update / delete checklist item |
| `/workspaces/{id}/search` | GET | Search |
| `/labels` | POST | Create labels |
| `/cards/{id}/attachments/upload-url` | POST | Presigned upload URL |
| `/cards/{id}/attachments/confirm` | POST | Confirm attachment |
| `/cards/{id}/activities` | GET | Activity feed |

Full API docs: [docs.kan.bn/api-reference](https://docs.kan.bn/api-reference/introduction)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No API key set" | Settings → Kan Sync → paste key from kan.bn/settings |
| Detect shows "No workspaces found" | Invalid key or empty account — test with `curl -H "Authorization: Bearer kan_..." https://kan.bn/api/v1/workspaces` |
| `Kan API 401/403` | Key missing/revoked — create a new one |
| Board view empty | Set workspace ID; hit ↻ |
| Pushed items missing | Only `- [ ]` creates cards; checked items are skipped unless already linked |
| Duplicate cards after rewording | Turn on ID markers and push once to adopt |
| Pull didn't add tags/due | Enable Pull due dates / tags / mentions; line needs a `%%kan:ID%%` marker |
| Delete command refused | Enable **Allow deletes on push** |
| Plugin not listed after manual install | Reload; ensure files sit directly in `.obsidian/plugins/kan-sync/` |

Errors also go to the developer console (`Ctrl/Cmd + Shift + I`).

## Limitations

- Without **Allow deletes**, sync is additive for labels, members, and completion (removing in the note never removes in Kan).
- Auto-sync pulls only; pushes stay manual.
- Card detail modal is read-mostly (commenting works; edit title/description in Kan or via note push).
- `@mention` matching needs workspace name or email prefix; unmatched mentions are logged, never guessed.
- Pull enrichment rebuilds meta tokens; keep important wording in the title portion of the line.

## Roadmap

- [x] Card↔item ID mapping — v0.2.0
- [x] Self-hosted base URL, drag & drop, due dates, `#tags`, auto-sync — v0.2.0
- [x] Retro-label, reordering, sub-items, search, comments, done-move — v0.3.0
- [x] Two-way subtasks, attachments — v0.4.0
- [x] Members, card modal, multi-workspace — v0.5.0
- [x] Community plugin store — v0.5.2
- [x] Description sync, richer pull, clear due, optional deletes, board/list rename — v0.6.0
- [x] Full Kan API coverage (board filters/templates, card modal CRUD, workspace admin, webhooks manage, imports) — v0.7.0
- [x] Slug resolve, named checklists, subtask rename/reorder, label colour sync, admin command wiring — v0.7.1
- [x] Scorecard disclosures / CONTRIBUTING / auto-sync timer hygiene — v0.7.2

New ideas welcome via GitHub issues.

## Changelog

### 0.7.2
- **Scorecard hygiene** — add `CONTRIBUTING.md` and `SECURITY.md`
- **Disclosures** — document the three `requestUrl` call sites, clipboard write (invite links), optional auto-sync, no payment/telemetry
- **Auto-sync** — replace permanent `setInterval` with a one-shot timer only while the interval setting is enabled (avoids setInterval+network heuristic)

### 0.7.1
- **Slug-based board resolve** — stores/uses `kan_board_slug` + `kan_workspace_slug` (and Settings workspace slug) on push/pull
- **Named checklists** — indented `### Name` under a card item maps to a Kan checklist of that name
- **Subtask rename & reorder** — push updates checklist item titles and indices (positional match when titles change)
- **Label name/colour sync** — existing `#tags` update Kan label casing and deterministic colour on push
- **Open Kan Sync settings (admin)** command; stats, invite lookup, get workspace/label, role/member permission inspect in Settings
- Workspace slug setting (auto-filled by Detect when available)

### 0.7.0
- **Full Kan API coverage** — client wraps all documented REST operations
- Board view: due/label/member filters, regular/template/archived lists, board actions (favorite, archive, visibility, slug, move, delete, templates), list drag-reorder and delete
- Card modal: edit title/description/due, toggle labels/members, checklist CRUD (rename/delete/reorder items), comment edit/delete, activity pagination, attachment delete + save to vault, duplicate options
- Push: new card position (start/end), list reorder to heading order, optional empty-list delete, `kan_template_id` / `kan_labels` frontmatter
- Settings admin: account/health, workspace CRUD, invites, members/roles/permissions, webhooks (manage only), Trello/GitHub import, label update/delete, danger-zone delete workspace
- Commands: test connection, import Trello/GitHub, invite/copy invite link, archive/favorite board, create from / save as template
- **Note:** Obsidian cannot receive inbound webhooks; webhook UI is for managing endpoints only

### 0.6.0
- **Description sync** — indented text under a checklist item becomes the card description
- **Richer pull** — optional sync of due dates, `#tags`, and `@mentions` from Kan onto note lines
- **Clear due date** — removing `📅` / `@due()` from a note clears the card due date on push
- **Members on create** — assignees sent in the create-card call
- **Optional deletes** — opt-in removal of cards, labels, members, and checklist items
- **Board & list rename** — rename Kan board/list from note / heading changes; `kan_board_id` frontmatter
- **Duplicate / delete card** commands
- README: Sync Conventions fixed; complete usage guide

### 0.5.2
- Documented network/account disclosures
- GitHub artifact attestations for release assets
- Community plugin store submission completed

### 0.5.1
- Remove "Obsidian" from manifest description (review requirement)
- MIT license file aligned with README

### 0.5.0
- `@mention` member sync; card detail modal; multi-workspace switcher
- Assignee names on board cards; `versions.json`

### 0.4.0
- Two-way sub-item completion; file/note attachments; attachment badges

### 0.3.0
- Sub-items, retro-labeling, done-move, comments, search, in-list reorder

### 0.2.0
- Drag & drop, ID markers, due dates, `#tags`, full sync, auto-sync, base URL

### 0.1.1
- Fix workspace detection response shape

### 0.1.0
- Initial release: board view, push, pull

## Development

Plain JavaScript, no build step — `main.js` is the plugin.

1. Edit `main.js`
2. Reload Obsidian (or use [Hot Reload](https://github.com/pjeby/hot-reload))
3. `node --check main.js` for a quick syntax gate

PRs and issues welcome.

## License

MIT © [x-o-r-r-o](https://github.com/x-o-r-r-o/)

*Kan.bn itself is [AGPL-3.0](https://github.com/kanbn/kan) — this plugin is an independent API client and is not affiliated with the Kan team.*
