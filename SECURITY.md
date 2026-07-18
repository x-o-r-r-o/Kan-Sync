---
plugin-id: kan-sync
version: 0.7.3
last-updated: 2026-07-18
---

# Security

## Network Activity

| Host | Purpose | Data Sent | Direction |
| --- | --- | --- | --- |
| kan.bn (or configured Base URL host) | Kan REST API — boards, lists, cards, labels, members, search, comments, checklists, webhooks admin, imports | API key (Authorization), note checklist titles/descriptions/due dates/tags/mentions, board metadata | outbound |
| Kan-issued presigned storage hosts (typically S3-compatible) | Attachment upload/download URLs returned by Kan | File bytes for attachments you choose to upload or save | outbound / inbound |

Default API base: `https://kan.bn/api/v1`. Self-hosted instances replace the host via Settings → Base URL.

## Data Collection

| Data Type | Scope | Purpose |
| --- | --- | --- |
| Markdown checklist notes | Active note (and files you attach) | Push/pull sync with Kan |
| Frontmatter (`kan_board`, IDs, slugs) | Active note | Board linking |
| API key / workspace settings | Plugin `data.json` | Authenticate to Kan |

## Third-Party Services

| Service | Purpose | Data Shared |
| --- | --- | --- |
| Kan.bn (or your self-hosted Kan) | Kanban board of record | Checklist content you push; board state you pull |
| Object storage behind Kan presigned URLs | Attachment bytes | Only files you explicitly attach or download |

Optional Trello/GitHub import uses Kan’s integration authorize URL (user-initiated browser open).

## Permissions

- Clipboard **write** for copying invite links (never read)
- No filesystem access outside the vault
- No shell / Node `child_process`
- No telemetry SDKs

## Data Storage

| What | Where | Encrypted |
| --- | --- | --- |
| API key, workspace ID, plugin settings | `<vault>/.obsidian/plugins/kan-sync/data.json` | No (vault-local plaintext) |
| Boards / cards | Kan servers (or self-hosted) | Per Kan / host policy |
| Status table & enriched checklist lines | In notes after pull | N/A (your vault) |

Report security issues via GitHub Security Advisories on [x-o-r-r-o/Kan-Sync](https://github.com/x-o-r-r-o/Kan-Sync) or a private contact to the author.
