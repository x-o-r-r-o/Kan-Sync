/* Kan Sync v0.7.1 — plugin for Kan.bn
 * https://github.com/x-o-r-r-o/
 *
 * v0.7.1: Slug-based board resolve, named checklists, subtask rename/reorder,
 * label name/colour sync, Open Kan admin + unused API lookups in UI.
 * v0.7.0: Full Kan API coverage — board filters/templates/archive, card modal
 * editing, comments/checklists/attachments CRUD, workspace admin, invites,
 * permissions, webhooks (manage), integrations/imports, health/users.
 * v0.6.0: description sync, richer pull, clear due, optional deletes, renames.
 */

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, requestUrl, Modal, SuggestModal } = require("obsidian");

const VIEW_TYPE_KAN = "kan-board-view";
const MARKER_RE = /\s*%%kan:([\w-]+)%%/;
const DUE_RE = /(?:📅|@due\()\s*(\d{4}-\d{2}-\d{2})\)?/u;
const TAG_RE = /(^|\s)#([\w/-]+)/g;
const MENTION_RE = /(^|\s)@([\w.-]+)/g;
const LABEL_COLOURS = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#34495e"];
const DESC_PREFIX = "From Obsidian: ";
const DUE_FILTERS = ["overdue", "today", "tomorrow", "next-week", "next-month", "no-due-date"];
const WEBHOOK_EVENTS = ["card.created", "card.updated", "card.moved", "card.deleted"];

const DEFAULT_SETTINGS = {
  apiKey: "",
  workspaceId: "",
  workspaceSlug: "",
  baseUrl: "https://kan.bn/api/v1",
  doneLists: "Done, Completed, Launched",
  useIdMarkers: true,
  syncTags: true,
  retroLabel: true,
  autoSyncMinutes: 0,
  statusHeading: "## Kan Board Status",
  defaultListName: "Backlog",
  subtaskChecklistName: "Subtasks",
  moveDoneCards: true,
  includeTitlesInStatus: true,
  syncSubtasks: true,
  syncMembers: true,
  syncDescription: true,
  pullDueDates: true,
  pullTags: true,
  pullMentions: true,
  allowDeletes: false,
  renameBoard: true,
  renameLists: true,
  newCardPosition: "end",
  reorderLists: true,
  showArchivedBoards: false,
  boardListType: "regular",
  boardDueFilter: "",
};

/* ---------------- query + API client ---------------- */

function qs(params) {
  if (!params) return "";
  const parts = [];
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null || item === "") continue;
        parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(item));
      }
    } else if (typeof v === "boolean") {
      parts.push(encodeURIComponent(key) + "=" + (v ? "true" : "false"));
    } else {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}

class KanClient {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }

  async req(method, path, body) {
    const { apiKey, baseUrl } = this.getSettings();
    if (!apiKey) throw new Error("No API key set (Settings → Kan Sync).");
    const res = await requestUrl({
      url: (baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/$/, "") + path,
      method,
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });
    if (res.status >= 400) {
      let msg = "";
      try { msg = (res.json && res.json.message) || res.text || ""; } catch (e) { /* ignore */ }
      throw new Error(`Kan API ${res.status} on ${method} ${path}: ${String(msg).slice(0, 200)}`);
    }
    return res.json;
  }

  // ---- health / users ----
  health() { return this.req("GET", "/health"); }
  stats() { return this.req("GET", "/stats"); }
  getMe() { return this.req("GET", "/users/me"); }
  updateUser(patch) { return this.req("PUT", "/users", patch); }
  setPassword(newPassword) { return this.req("POST", "/users/me/password", { newPassword }); }

  // ---- workspaces ----
  async getWorkspaces() {
    const raw = await this.req("GET", "/workspaces");
    return (raw || []).map((w) => (w && w.workspace) ? w.workspace : w).filter(Boolean);
  }
  getWorkspace(wsId) { return this.req("GET", `/workspaces/${wsId}`); }
  getWorkspaceBySlug(slug) { return this.req("GET", `/workspaces/${encodeURIComponent(slug)}`); }
  createWorkspace(body) { return this.req("POST", "/workspaces", body); }
  updateWorkspace(wsId, patch) { return this.req("PUT", `/workspaces/${wsId}`, patch); }
  deleteWorkspace(wsId) { return this.req("DELETE", `/workspaces/${wsId}`); }
  checkWorkspaceSlug(slug) {
    return this.req("GET", `/workspaces/check-slug-availability${qs({ workspaceSlug: slug })}`);
  }

  // ---- boards ----
  getBoards(wsId, opts) {
    return this.req("GET", `/workspaces/${wsId}/boards${qs(opts || {})}`);
  }
  getBoard(boardId, filters) {
    return this.req("GET", `/boards/${boardId}${qs(filters || {})}`);
  }
  getBoardBySlug(wsSlug, boardSlug, filters) {
    return this.req("GET", `/workspaces/${encodeURIComponent(wsSlug)}/boards/${encodeURIComponent(boardSlug)}${qs(filters || {})}`);
  }
  createBoard(wsId, name, listNames, opts) {
    opts = opts || {};
    return this.req("POST", `/workspaces/${wsId}/boards`, {
      name,
      lists: listNames || [],
      labels: opts.labels || [],
      type: opts.type || "regular",
      sourceBoardPublicId: opts.sourceBoardPublicId,
    });
  }
  updateBoard(boardId, patch) { return this.req("PUT", `/boards/${boardId}`, patch); }
  deleteBoard(boardId) { return this.req("DELETE", `/boards/${boardId}`); }
  checkBoardSlug(boardId, boardSlug) {
    return this.req("GET", `/boards/${boardId}/check-slug-availability${qs({ boardSlug })}`);
  }
  moveBoard(boardId, targetWorkspacePublicId) {
    return this.req("POST", `/boards/${boardId}/move`, { targetWorkspacePublicId });
  }

  // ---- lists ----
  createList(boardId, name) { return this.req("POST", "/lists", { name, boardPublicId: boardId }); }
  updateList(listId, patch) { return this.req("PUT", `/lists/${listId}`, patch); }
  deleteList(listId) { return this.req("DELETE", `/lists/${listId}`); }

  // ---- cards ----
  createCard(listId, title, description, dueDate, labelPublicIds, memberPublicIds, position) {
    return this.req("POST", "/cards", {
      title: title.slice(0, 2000),
      description: (description || "").slice(0, 10000),
      listPublicId: listId,
      labelPublicIds: labelPublicIds || [],
      memberPublicIds: memberPublicIds || [],
      position: position === "start" ? "start" : "end",
      dueDate: dueDate || null,
    });
  }
  getCard(cardId) { return this.req("GET", `/cards/${cardId}`); }
  updateCard(cardId, patch) { return this.req("PUT", `/cards/${cardId}`, patch); }
  deleteCard(cardId) { return this.req("DELETE", `/cards/${cardId}`); }
  duplicateCard(cardId, listPublicId, opts) {
    opts = opts || {};
    const body = {
      listPublicId,
      copyLabels: opts.copyLabels !== false,
      copyMembers: opts.copyMembers !== false,
      copyChecklists: opts.copyChecklists !== false,
    };
    if (opts.title) body.title = opts.title;
    if (opts.index !== undefined && opts.index !== null) body.index = opts.index;
    return this.req("POST", `/cards/${cardId}/duplicate`, body);
  }
  getCardActivities(cardId, limit, cursor) {
    return this.req("GET", `/cards/${cardId}/activities${qs({ limit: limit || 20, cursor })}`);
  }
  toggleCardLabel(cardId, labelId) { return this.req("PUT", `/cards/${cardId}/labels/${labelId}`); }
  toggleCardMember(cardId, memberId) { return this.req("PUT", `/cards/${cardId}/members/${memberId}`); }
  addComment(cardId, comment) { return this.req("POST", `/cards/${cardId}/comments`, { comment }); }
  updateComment(cardId, commentId, comment) {
    return this.req("PUT", `/cards/${cardId}/comments/${commentId}`, { comment });
  }
  deleteComment(cardId, commentId) { return this.req("DELETE", `/cards/${cardId}/comments/${commentId}`); }

  // ---- checklists ----
  createChecklist(cardId, name) { return this.req("POST", `/cards/${cardId}/checklists`, { name: name.slice(0, 255) }); }
  updateChecklist(checklistId, patch) { return this.req("PUT", `/checklists/${checklistId}`, patch); }
  deleteChecklist(checklistId) { return this.req("DELETE", `/checklists/${checklistId}`); }
  addChecklistItem(checklistId, title) { return this.req("POST", `/checklists/${checklistId}/items`, { title: title.slice(0, 500) }); }
  updateChecklistItem(itemId, patch) { return this.req("PATCH", `/checklists/items/${itemId}`, patch); }
  deleteChecklistItem(itemId) { return this.req("DELETE", `/checklists/items/${itemId}`); }

  // ---- labels ----
  createLabel(boardId, name, colourCode) {
    return this.req("POST", "/labels", { name: name.slice(0, 36), boardPublicId: boardId, colourCode });
  }
  getLabel(labelId) { return this.req("GET", `/labels/${labelId}`); }
  updateLabel(labelId, patch) { return this.req("PUT", `/labels/${labelId}`, patch); }
  deleteLabel(labelId) { return this.req("DELETE", `/labels/${labelId}`); }

  // ---- attachments ----
  getAttachmentUploadUrl(cardId, filename, contentType, size) {
    return this.req("POST", `/cards/${cardId}/attachments/upload-url`, { filename: filename.slice(0, 255), contentType, size });
  }
  confirmAttachment(cardId, s3Key, filename, contentType, size) {
    return this.req("POST", `/cards/${cardId}/attachments/confirm`, {
      s3Key, filename: filename.slice(0, 255), originalFilename: filename.slice(0, 255), contentType, size,
    });
  }
  deleteAttachment(attachmentId) { return this.req("DELETE", `/attachments/${attachmentId}`); }
  async uploadToPresigned(url, data, contentType) {
    const res = await requestUrl({ url, method: "PUT", headers: { "Content-Type": contentType }, body: data, throw: false });
    if (res.status >= 400) throw new Error(`S3 upload failed (${res.status})`);
  }

  // ---- search ----
  search(wsId, query, limit) {
    return this.req("GET", `/workspaces/${wsId}/search${qs({ query: String(query).slice(0, 100), limit: limit || 20 })}`);
  }

  // ---- members / invites ----
  inviteMember(wsId, email) {
    return this.req("POST", `/workspaces/${wsId}/members/invite`, { email });
  }
  removeMember(wsId, memberId) { return this.req("DELETE", `/workspaces/${wsId}/members/${memberId}`); }
  updateMemberRole(wsId, memberId, role) {
    return this.req("PUT", `/workspaces/${wsId}/members/${memberId}/role`, { role });
  }
  getInviteLink(wsId) { return this.req("GET", `/workspaces/${wsId}/invite`); }
  createInviteLink(wsId) { return this.req("POST", `/workspaces/${wsId}/invites`); }
  deactivateInviteLink(wsId) { return this.req("DELETE", `/workspaces/${wsId}/invites`); }
  getInviteInfo(code) { return this.req("GET", `/invites/${encodeURIComponent(code)}`); }
  acceptInvite(inviteCode) { return this.req("POST", "/invites/accept", { inviteCode }); }

  // ---- permissions ----
  getMyPermissions(wsId) { return this.req("GET", `/workspaces/${wsId}/permissions/me`); }
  getRoles(wsId) { return this.req("GET", `/workspaces/${wsId}/roles`); }
  getWorkspaceRolePermissions(wsId) { return this.req("GET", `/workspaces/${wsId}/roles/permissions`); }
  getRolePermissions(wsId, roleId) { return this.req("GET", `/workspaces/${wsId}/roles/${roleId}/permissions`); }
  getMemberPermissions(wsId, memberId) {
    return this.req("GET", `/workspaces/${wsId}/members/${memberId}/permissions`);
  }
  grantRolePermission(wsId, roleId, permission) {
    return this.req("POST", `/workspaces/${wsId}/roles/${roleId}/permissions/grant`, { permission });
  }
  revokeRolePermission(wsId, roleId, permission) {
    return this.req("POST", `/workspaces/${wsId}/roles/${roleId}/permissions/revoke`, { permission });
  }
  grantMemberPermission(wsId, memberId, permission) {
    return this.req("POST", `/workspaces/${wsId}/members/${memberId}/permissions/grant`, { permission });
  }
  revokeMemberPermission(wsId, memberId, permission) {
    return this.req("POST", `/workspaces/${wsId}/members/${memberId}/permissions/revoke`, { permission });
  }
  resetMemberPermissions(wsId, memberId) {
    return this.req("POST", `/workspaces/${wsId}/members/${memberId}/permissions/reset`);
  }
  resetAllMemberPermissions(wsId) {
    return this.req("POST", `/workspaces/${wsId}/members/permissions/reset`);
  }

  // ---- webhooks ----
  getWebhooks(wsId) { return this.req("GET", `/workspaces/${wsId}/webhooks`); }
  createWebhook(wsId, body) { return this.req("POST", `/workspaces/${wsId}/webhooks`, body); }
  updateWebhook(wsId, webhookId, patch) { return this.req("PUT", `/workspaces/${wsId}/webhooks/${webhookId}`, patch); }
  deleteWebhook(wsId, webhookId) { return this.req("DELETE", `/workspaces/${wsId}/webhooks/${webhookId}`); }
  testWebhook(wsId, webhookId) { return this.req("POST", `/workspaces/${wsId}/webhooks/${webhookId}/test`); }

  // ---- integrations / imports ----
  getIntegrationProviders() { return this.req("GET", "/integration/providers"); }
  getIntegrationAuthorizeUrl(provider) {
    return this.req("GET", `/integration/authorize${qs({ provider })}`);
  }
  disconnectIntegration(provider) { return this.req("POST", "/integration/disconnect", { provider }); }
  getTrelloBoards() { return this.req("GET", "/integrations/trello/boards"); }
  getGithubProjects() { return this.req("GET", "/integrations/github/projects"); }
  importTrelloBoards(workspacePublicId, boardIds) {
    return this.req("POST", "/imports/trello/boards", { workspacePublicId, boardIds });
  }
  importGithubProjects(workspacePublicId, projectIds) {
    return this.req("POST", "/imports/github/projects", { workspacePublicId, projectIds });
  }
}

const MAX_ATTACHMENT = 52428800; // 50 MB API limit

/* ---------------- helpers ---------------- */

function cleanText(s) {
  return s
    .replace(MARKER_RE, "")
    .replace(DUE_RE, "")
    .replace(TAG_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (m, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function labelColour(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return LABEL_COLOURS[h % LABEL_COLOURS.length];
}

function toIsoDue(ymd) { return ymd ? new Date(ymd + "T12:00:00.000Z").toISOString() : null; }
function normTitle(s) { return cleanText(s).toLowerCase(); }

function buildCardDescription(notePath, body) {
  const header = DESC_PREFIX + notePath;
  const text = (body || "").trim();
  return text ? (header + "\n\n" + text).slice(0, 10000) : header;
}

function memberHandle(m) {
  const name = (m.user && m.user.name) || "";
  if (name) return name.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9._-]/gi, "");
  const email = (m.email || "").split("@")[0];
  return email.toLowerCase().replace(/[^a-z0-9._-]/gi, "") || null;
}

/** Rebuild checklist item meta (due / tags / mentions / marker) from Kan card data. */
function enrichChecklistLine(line, card, settings) {
  const m = line.match(/^(\s*-\s*\[(?: |x|X)\]\s+)(.*)$/);
  if (!m) return line;
  const prefix = m[1];
  let rest = m[2];
  const marker = (rest.match(MARKER_RE) || [])[0] || (card.publicId ? ` %%kan:${card.publicId}%%` : "");
  rest = rest.replace(MARKER_RE, "").replace(DUE_RE, "").replace(TAG_RE, " ").replace(MENTION_RE, " ");
  rest = rest.replace(/\s+/g, " ").trim();

  const bits = [rest];
  if (settings.pullDueDates) {
    if (card.dueDate) bits.push("📅 " + String(card.dueDate).slice(0, 10));
  }
  if (settings.pullTags) {
    for (const l of card.labels || []) {
      const tag = String(l.name || "").replace(/\s+/g, "-");
      if (tag) bits.push("#" + tag);
    }
  }
  if (settings.pullMentions) {
    for (const mem of card.members || []) {
      const h = memberHandle(mem);
      if (h) bits.push("@" + h);
    }
  }
  return prefix + bits.join(" ") + (marker ? (marker.startsWith(" ") ? marker : " " + marker.trim()) : "");
}

// Parse note → sections with items, nested sub-items (optionally under ### checklist names), and description lines.
function parseNote(content, defaultListName, defaultChecklistName) {
  const lines = content.split("\n");
  const sections = [];
  let current = { name: defaultListName || "Backlog", items: [] };
  let inCode = false;
  let lastTopItem = null;
  let activeChecklist = defaultChecklistName || "Subtasks";

  lines.forEach((line, lineNo) => {
    if (/^```/.test(line.trim())) { inCode = !inCode; return; }
    if (inCode) return;

    // Top-level ##–#### headings = Kan lists (not indented)
    const h = line.match(/^#{2,4}\s+(.*)/);
    if (h && !/^\s/.test(line)) {
      if (current.items.length) sections.push(current);
      current = { name: cleanText(h[1]), items: [] };
      lastTopItem = null;
      activeChecklist = defaultChecklistName || "Subtasks";
      return;
    }

    // Indented ### under a card → named checklist block
    const clHead = line.match(/^\s+#{3}\s+(.*)/);
    if (clHead && lastTopItem) {
      activeChecklist = cleanText(clHead[1]) || (defaultChecklistName || "Subtasks");
      return;
    }

    const m = line.match(/^(\s*)-\s*\[( |x|X)\]\s+(.*)/);
    if (m) {
      const indent = m[1].length;
      const rest = m[3];
      const kanId = (rest.match(MARKER_RE) || [])[1] || null;
      const due = (rest.match(DUE_RE) || [])[1] || null;
      const tags = [];
      let t;
      const tagRe = new RegExp(TAG_RE.source, "g");
      while ((t = tagRe.exec(rest)) !== null) tags.push(t[2]);
      const mentions = [];
      const menRe = new RegExp(MENTION_RE.source, "g");
      while ((t = menRe.exec(rest)) !== null) mentions.push(t[2]);
      const title = cleanText(rest);
      if (!title) return;

      if (indent === 0) {
        activeChecklist = defaultChecklistName || "Subtasks";
        lastTopItem = {
          done: m[2] !== " ", title, kanId, due, tags, mentions, lineNo,
          children: [], description: "",
        };
        current.items.push(lastTopItem);
      } else if (lastTopItem) {
        lastTopItem.children.push({
          done: m[2] !== " ",
          title,
          lineNo,
          checklistName: activeChecklist,
        });
      }
      return;
    }

    // Indented non-checkbox text under a top-level item → card description
    // (ignore indented headings already handled)
    if (lastTopItem && /^\s+\S/.test(line) && !/^\s*-\s*\[/.test(line) && !/^\s+#{3}\s+/.test(line)) {
      const text = line.replace(/^\s+/, "");
      lastTopItem.description = lastTopItem.description
        ? lastTopItem.description + "\n" + text
        : text;
    }
  });
  if (current.items.length) sections.push(current);
  return { sections, lines };
}

/* ---------------- shared modals ---------------- */

class KanConfirmModal extends Modal {
  constructor(app, title, message, onConfirm) {
    super(app);
    this.titleText = title;
    this.message = message;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.titleText });
    contentEl.createDiv({ text: this.message, cls: "kan-modal-section" });
    const row = contentEl.createDiv({ cls: "kan-btn-row" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const ok = row.createEl("button", { text: "Confirm", cls: "mod-warning" });
    ok.onclick = async () => {
      this.close();
      try { await this.onConfirm(); } catch (e) { new Notice("Kan error: " + e.message, 8000); console.error(e); }
    };
  }
  onClose() { this.contentEl.empty(); }
}

class KanPromptModal extends Modal {
  constructor(app, title, fields, onSubmit) {
    super(app);
    this.titleText = title;
    this.fields = fields; // [{key, label, value, type, placeholder}]
    this.onSubmit = onSubmit;
    this.values = {};
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.titleText });
    for (const f of this.fields) {
      const wrap = contentEl.createDiv({ cls: "kan-field" });
      wrap.createEl("label", { text: f.label });
      if (f.type === "textarea") {
        const ta = wrap.createEl("textarea", { cls: "kan-comment-input" });
        ta.value = f.value || "";
        ta.rows = f.rows || 3;
        ta.placeholder = f.placeholder || "";
        this.values[f.key] = ta;
      } else if (f.type === "select") {
        const sel = wrap.createEl("select", { cls: "kan-select" });
        for (const opt of f.options || []) {
          const o = sel.createEl("option", { text: opt.label, value: opt.value });
          if (String(opt.value) === String(f.value)) o.selected = true;
        }
        this.values[f.key] = sel;
      } else if (f.type === "toggle") {
        const inp = wrap.createEl("input");
        inp.type = "checkbox";
        inp.checked = !!f.value;
        this.values[f.key] = inp;
      } else {
        const inp = wrap.createEl("input", { cls: "kan-input" });
        inp.type = f.type || "text";
        inp.value = f.value || "";
        inp.placeholder = f.placeholder || "";
        this.values[f.key] = inp;
      }
    }
    const row = contentEl.createDiv({ cls: "kan-btn-row" });
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = row.createEl("button", { text: "Save", cls: "mod-cta" });
    ok.onclick = async () => {
      const out = {};
      for (const f of this.fields) {
        const el = this.values[f.key];
        if (f.type === "toggle") out[f.key] = el.checked;
        else out[f.key] = el.value;
      }
      this.close();
      try { await this.onSubmit(out); } catch (e) { new Notice("Kan error: " + e.message, 8000); console.error(e); }
    };
  }
  onClose() { this.contentEl.empty(); }
}

class KanDuplicateModal extends Modal {
  constructor(app, plugin, card) {
    super(app);
    this.plugin = plugin;
    this.card = card;
  }
  onOpen() {
    const { contentEl } = this;
    const card = this.card;
    const board = card.list && card.list.board;
    contentEl.createEl("h3", { text: "Duplicate card" });
    const title = contentEl.createEl("input", { cls: "kan-input", attr: { placeholder: "Title (optional)" } });
    title.value = (card.title || "") + " (copy)";
    const listSel = contentEl.createEl("select", { cls: "kan-select" });
    const lists = (board && board.lists) || (card.list ? [card.list] : []);
    for (const l of lists) {
      const o = listSel.createEl("option", { text: l.name, value: l.publicId });
      if (card.list && l.publicId === card.list.publicId) o.selected = true;
    }
    const copyLabels = contentEl.createEl("label"); copyLabels.createEl("input", { attr: { type: "checkbox" } }).checked = true; copyLabels.appendText(" Copy labels");
    const copyMembers = contentEl.createEl("label"); copyMembers.createEl("input", { attr: { type: "checkbox" } }).checked = true; copyMembers.appendText(" Copy members");
    const copyChecklists = contentEl.createEl("label"); copyChecklists.createEl("input", { attr: { type: "checkbox" } }).checked = true; copyChecklists.appendText(" Copy checklists");
    copyLabels.style.display = copyMembers.style.display = copyChecklists.style.display = "block";
    const row = contentEl.createDiv({ cls: "kan-btn-row" });
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    row.createEl("button", { text: "Duplicate", cls: "mod-cta" }).onclick = async () => {
      try {
        await this.plugin.client.duplicateCard(card.publicId, listSel.value, {
          title: title.value.trim() || undefined,
          copyLabels: copyLabels.querySelector("input").checked,
          copyMembers: copyMembers.querySelector("input").checked,
          copyChecklists: copyChecklists.querySelector("input").checked,
        });
        new Notice("Card duplicated.");
        this.close();
      } catch (e) { new Notice("Kan error: " + e.message, 8000); }
    };
  }
  onClose() { this.contentEl.empty(); }
}

class KanImportModal extends Modal {
  constructor(app, plugin, kind) {
    super(app);
    this.plugin = plugin;
    this.kind = kind; // trello | github
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.kind === "trello" ? "Import Trello boards" : "Import GitHub projects" });
    contentEl.setText("Loading…");
    let items = [];
    try {
      items = this.kind === "trello"
        ? (await this.plugin.client.getTrelloBoards()) || []
        : (await this.plugin.client.getGithubProjects()) || [];
    } catch (e) {
      contentEl.setText("Error: " + e.message + " — connect the integration in Kan first.");
      return;
    }
    contentEl.empty();
    contentEl.createEl("h3", { text: this.kind === "trello" ? "Import Trello boards" : "Import GitHub projects" });
    if (!items.length) { contentEl.createDiv({ text: "No items found." }); return; }
    const boxes = [];
    for (const it of items) {
      const row = contentEl.createDiv({ cls: "kan-field" });
      const cb = row.createEl("input", { attr: { type: "checkbox" } });
      const id = it.id || it.publicId || it.boardId || it.projectId;
      const name = it.name || it.title || String(id);
      row.appendText(" " + name);
      boxes.push({ cb, id });
    }
    const btnRow = contentEl.createDiv({ cls: "kan-btn-row" });
    btnRow.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    btnRow.createEl("button", { text: "Import", cls: "mod-cta" }).onclick = async () => {
      const ids = boxes.filter((b) => b.cb.checked).map((b) => b.id);
      if (!ids.length) { new Notice("Select at least one."); return; }
      const ws = this.plugin.settings.workspaceId;
      try {
        if (this.kind === "trello") await this.plugin.client.importTrelloBoards(ws, ids);
        else await this.plugin.client.importGithubProjects(ws, ids);
        new Notice(`Imported ${ids.length} item(s).`);
        this.close();
      } catch (e) { new Notice("Kan error: " + e.message, 8000); }
    };
  }
  onClose() { this.contentEl.empty(); }
}

/* ---------------- search modal ---------------- */

class KanSearchModal extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Search Kan boards and cards…");
  }

  async getSuggestions(query) {
    if (!query || query.length < 2) return [];
    try { return await this.plugin.client.search(this.plugin.settings.workspaceId, query); }
    catch (e) { console.error(e); return []; }
  }

  renderSuggestion(item, el) {
    el.createDiv({ text: (item.type === "board" ? "📋 " : "🃏 ") + item.title });
    if (item.type === "card")
      el.createDiv({ cls: "kan-suggest-sub", text: `${item.boardName} → ${item.listName}` });
  }

  async onChooseSuggestion(item) {
    const boardId = item.type === "board" ? item.publicId : item.boardPublicId;
    await this.plugin.openBoard(boardId);
  }
}

/* ---------------- comment modal ---------------- */

class KanCommentModal extends Modal {
  constructor(app, plugin, cardId, cardTitle) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    this.cardTitle = cardTitle;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Comment on: " + (this.cardTitle || this.cardId) });
    const ta = contentEl.createEl("textarea", { cls: "kan-comment-input" });
    ta.rows = 4;
    const btn = contentEl.createEl("button", { text: "Add comment", cls: "mod-cta" });
    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return;
      try {
        await this.plugin.client.addComment(this.cardId, text);
        new Notice("Comment added.");
        this.close();
      } catch (e) { new Notice("Kan error: " + e.message, 8000); }
    };
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------------- card detail modal ---------------- */

class KanCardModal extends Modal {
  constructor(app, plugin, cardId) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    this.activityCursor = null;
    this.extraActivities = [];
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("kan-card-modal");
    contentEl.setText("Loading card…");
    let card;
    try { card = await this.plugin.client.getCard(this.cardId); }
    catch (e) { contentEl.setText("Error: " + e.message); return; }
    this.card = card;
    contentEl.empty();

    const prefix = card.list?.board?.workspace?.cardPrefix;
    const head = contentEl.createDiv({ cls: "kan-modal-head" });
    head.createEl("h3", { text: (prefix && card.cardNumber ? `${prefix}-${card.cardNumber} · ` : "") + card.title });
    const actions = head.createDiv({ cls: "kan-btn-row" });
    actions.createEl("button", { text: "Edit" }).onclick = () => this.editCard(card);
    actions.createEl("button", { text: "Duplicate" }).onclick = () => new KanDuplicateModal(this.app, this.plugin, card).open();

    const meta = contentEl.createDiv({ cls: "kan-modal-meta" });
    meta.createSpan({ text: `📁 ${card.list?.board?.name || ""} → ${card.list?.name || ""}` });
    if (card.dueDate) meta.createSpan({ text: `  ·  📅 ${String(card.dueDate).slice(0, 10)}` });

    // labels toggle
    contentEl.createEl("h5", { text: "Labels" });
    const boardLabels = (card.list && card.list.board && card.list.board.labels) || card.boardLabels || [];
    const haveLabels = new Set((card.labels || []).map((l) => l.publicId));
    const lblRow = contentEl.createDiv({ cls: "kan-card-labels" });
    const labelSource = boardLabels.length ? boardLabels : (card.labels || []);
    for (const l of labelSource) {
      const span = lblRow.createEl("button", { cls: "kan-label", text: (haveLabels.has(l.publicId) ? "✓ " : "") + l.name });
      if (l.colourCode) span.style.background = l.colourCode + "33";
      span.onclick = async () => {
        try {
          await this.plugin.client.toggleCardLabel(this.cardId, l.publicId);
          this.extraActivities = []; this.activityCursor = null;
          await this.onOpen();
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      };
    }
    if (!labelSource.length) contentEl.createDiv({ cls: "kan-modal-section", text: "No labels on board." });

    // members toggle
    contentEl.createEl("h5", { text: "Members" });
    const wsMembers = (card.list && card.list.board && card.list.board.workspace && card.list.board.workspace.members) || [];
    const haveMembers = new Set((card.members || []).map((m) => m.publicId));
    const memRow = contentEl.createDiv({ cls: "kan-btn-row" });
    const memberSource = wsMembers.length ? wsMembers : (card.members || []);
    for (const m of memberSource) {
      const name = (m.user && m.user.name) || m.email || m.publicId;
      const btn = memRow.createEl("button", { text: (haveMembers.has(m.publicId) ? "✓ " : "") + name });
      btn.onclick = async () => {
        try {
          await this.plugin.client.toggleCardMember(this.cardId, m.publicId);
          await this.onOpen();
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      };
    }
    if (!memberSource.length) contentEl.createDiv({ cls: "kan-modal-section", text: "No workspace members loaded." });

    contentEl.createEl("h5", { text: "Description" });
    contentEl.createDiv({ cls: "kan-modal-desc", text: card.description || "(empty)" });

    // checklists
    contentEl.createEl("h5", { text: "Checklists" });
    for (const cl of card.checklists || []) {
      const total = (cl.items || []).length;
      const done = (cl.items || []).filter((i) => i.completed).length;
      const clHead = contentEl.createDiv({ cls: "kan-btn-row" });
      clHead.createEl("strong", { text: `${cl.name} (${done}/${total})` });
      clHead.createEl("button", { text: "Rename" }).onclick = () => {
        new KanPromptModal(this.app, "Rename checklist", [
          { key: "name", label: "Name", value: cl.name },
        ], async (v) => {
          await this.plugin.client.updateChecklist(cl.publicId, { name: v.name });
          await this.onOpen();
        }).open();
      };
      clHead.createEl("button", { text: "Delete", cls: "mod-warning" }).onclick = () => {
        new KanConfirmModal(this.app, "Delete checklist", `Delete checklist "${cl.name}"?`, async () => {
          await this.plugin.client.deleteChecklist(cl.publicId);
          await this.onOpen();
        }).open();
      };
      const ul = contentEl.createEl("ul", { cls: "kan-modal-checklist" });
      (cl.items || []).forEach((it, idx) => {
        const li = ul.createEl("li", { cls: "kan-btn-row" });
        const toggle = li.createEl("button", { text: it.completed ? "☑" : "☐" });
        toggle.onclick = async () => {
          await this.plugin.client.updateChecklistItem(it.publicId, { completed: !it.completed });
          await this.onOpen();
        };
        li.createSpan({ text: " " + it.title + " " });
        li.createEl("button", { text: "Edit" }).onclick = () => {
          new KanPromptModal(this.app, "Edit checklist item", [
            { key: "title", label: "Title", value: it.title },
          ], async (v) => {
            await this.plugin.client.updateChecklistItem(it.publicId, { title: v.title, index: idx });
            await this.onOpen();
          }).open();
        };
        if (idx > 0) {
          li.createEl("button", { text: "↑" }).onclick = async () => {
            await this.plugin.client.updateChecklistItem(it.publicId, { index: idx - 1 });
            await this.onOpen();
          };
        }
        li.createEl("button", { text: "Del" }).onclick = async () => {
          await this.plugin.client.deleteChecklistItem(it.publicId);
          await this.onOpen();
        };
      });
      const addItem = contentEl.createEl("button", { text: "+ Item" });
      addItem.onclick = () => {
        new KanPromptModal(this.app, "Add checklist item", [
          { key: "title", label: "Title", value: "" },
        ], async (v) => {
          if (!v.title.trim()) return;
          await this.plugin.client.addChecklistItem(cl.publicId, v.title.trim());
          await this.onOpen();
        }).open();
      };
    }
    contentEl.createEl("button", { text: "+ Checklist" }).onclick = () => {
      new KanPromptModal(this.app, "New checklist", [
        { key: "name", label: "Name", value: "Checklist" },
      ], async (v) => {
        await this.plugin.client.createChecklist(this.cardId, v.name || "Checklist");
        await this.onOpen();
      }).open();
    };

    // attachments
    contentEl.createEl("h5", { text: "Attachments" });
    const ul = contentEl.createEl("ul", { cls: "kan-modal-checklist" });
    for (const a of card.attachments || []) {
      const li = ul.createEl("li", { cls: "kan-btn-row" });
      const name = a.originalFilename || a.s3Key;
      if (a.url) li.createEl("a", { text: "📎 " + name, href: a.url });
      else li.createSpan({ text: "📎 " + name });
      if (a.url) {
        li.createEl("button", { text: "Save" }).onclick = async () => {
          try {
            await this.plugin.saveAttachmentToVault(a);
            new Notice("Saved to vault.");
          } catch (e) { new Notice("Kan error: " + e.message, 8000); }
        };
      }
      li.createEl("button", { text: "Delete", cls: "mod-warning" }).onclick = () => {
        new KanConfirmModal(this.app, "Delete attachment", `Delete "${name}"?`, async () => {
          await this.plugin.client.deleteAttachment(a.publicId);
          await this.onOpen();
        }).open();
      };
    }
    if (!(card.attachments || []).length) contentEl.createDiv({ cls: "kan-modal-section", text: "No attachments." });

    // activity + comments from activities
    contentEl.createEl("h5", { text: "Activity" });
    const feed = contentEl.createDiv({ cls: "kan-modal-activity" });
    let acts = (card.activities || []).slice();
    if (this.extraActivities.length) acts = acts.concat(this.extraActivities);
    if (!acts.length) feed.setText("No activity.");
    for (const a of acts.slice().reverse()) this.renderActivity(feed, a);

    const loadMore = contentEl.createEl("button", { text: "Load more activity" });
    loadMore.onclick = async () => {
      try {
        const page = await this.plugin.client.getCardActivities(this.cardId, 20, this.activityCursor);
        const list = Array.isArray(page) ? page : (page && (page.items || page.activities)) || [];
        const next = page && (page.nextCursor || page.cursor || (page.meta && page.meta.cursor));
        if (next) this.activityCursor = next;
        this.extraActivities = this.extraActivities.concat(list);
        await this.onOpen();
      } catch (e) { new Notice("Kan error: " + e.message, 8000); }
    };

    // comments list with edit/delete when comment id present
    contentEl.createEl("h5", { text: "Comments" });
    for (const a of acts) {
      if (!(a.comment && a.comment.comment)) continue;
      const row = contentEl.createDiv({ cls: "kan-btn-row" });
      row.createSpan({ text: a.comment.comment });
      const cid = a.comment.publicId;
      if (cid) {
        row.createEl("button", { text: "Edit" }).onclick = () => {
          new KanPromptModal(this.app, "Edit comment", [
            { key: "comment", label: "Comment", type: "textarea", value: a.comment.comment },
          ], async (v) => {
            await this.plugin.client.updateComment(this.cardId, cid, v.comment);
            this.extraActivities = []; this.activityCursor = null;
            await this.onOpen();
          }).open();
        };
        row.createEl("button", { text: "Delete", cls: "mod-warning" }).onclick = () => {
          new KanConfirmModal(this.app, "Delete comment", "Delete this comment?", async () => {
            await this.plugin.client.deleteComment(this.cardId, cid);
            this.extraActivities = []; this.activityCursor = null;
            await this.onOpen();
          }).open();
        };
      }
    }

    const ta = contentEl.createEl("textarea", { cls: "kan-comment-input" });
    ta.rows = 2;
    ta.placeholder = "Write a comment…";
    const btn = contentEl.createEl("button", { text: "Comment", cls: "mod-cta" });
    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return;
      try {
        await this.plugin.client.addComment(this.cardId, text);
        new Notice("Comment added.");
        this.extraActivities = []; this.activityCursor = null;
        await this.onOpen();
      } catch (e) { new Notice("Kan error: " + e.message, 8000); }
    };
  }

  renderActivity(feed, a) {
    const when = String(a.createdAt || "").slice(0, 16).replace("T", " ");
    const who = (a.user && (a.user.name || a.user.email)) || "";
    let what = a.type || "activity";
    if (a.comment && a.comment.comment) what = `💬 ${a.comment.comment}`;
    else if (a.fromList && a.toList) what = `moved ${a.fromList.name} → ${a.toList.name}`;
    else if (a.toTitle && a.fromTitle) what = `renamed "${a.fromTitle}" → "${a.toTitle}"`;
    else if (a.label) what = `label: ${a.label.name}`;
    else if (a.member) what = `member: ${(a.member.user && a.member.user.name) || ""}`;
    feed.createDiv({ cls: "kan-activity-row", text: `${when} ${who ? "· " + who + " " : ""}· ${what}` });
  }

  editCard(card) {
    new KanPromptModal(this.app, "Edit card", [
      { key: "title", label: "Title", value: card.title || "" },
      { key: "description", label: "Description", type: "textarea", value: card.description || "", rows: 6 },
      { key: "dueDate", label: "Due date (YYYY-MM-DD, empty to clear)", value: card.dueDate ? String(card.dueDate).slice(0, 10) : "" },
    ], async (v) => {
      const patch = {
        title: v.title.slice(0, 2000),
        description: v.description.slice(0, 10000),
        dueDate: v.dueDate.trim() ? toIsoDue(v.dueDate.trim()) : null,
      };
      await this.plugin.client.updateCard(this.cardId, patch);
      new Notice("Card updated.");
      await this.onOpen();
    }).open();
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------------- board view ---------------- */

class KanBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.boards = [];
    this.selectedBoardId = null;
    this.filterDue = plugin.settings.boardDueFilter || "";
    this.filterLabelIds = [];
    this.filterMemberIds = [];
    this.currentBoard = null;
  }

  getViewType() { return VIEW_TYPE_KAN; }
  getDisplayText() { return "Kan boards"; }
  getIcon() { return "layout-dashboard"; }

  async onOpen() { await this.render(); }

  boardFilters() {
    const f = {};
    if (this.filterDue) f.dueDateFilters = [this.filterDue];
    if (this.filterLabelIds.length) f.labels = this.filterLabelIds;
    if (this.filterMemberIds.length) f.members = this.filterMemberIds;
    return f;
  }

  async render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("kan-view");
    const self = this;

    const header = el.createDiv({ cls: "kan-header" });
    const wsSelect = header.createEl("select", { cls: "kan-select kan-ws-select", attr: { "aria-label": "Workspace" } });
    const typeSelect = header.createEl("select", { cls: "kan-select kan-type-select", attr: { "aria-label": "Board type" } });
    for (const [v, t] of [["regular", "Boards"], ["template", "Templates"]]) {
      const o = typeSelect.createEl("option", { text: t, value: v });
      if ((this.plugin.settings.boardListType || "regular") === v) o.selected = true;
    }
    const select = header.createEl("select", { cls: "kan-select" });
    const menuBtn = header.createEl("button", { text: "⋯", cls: "kan-refresh", attr: { "aria-label": "Board actions" } });
    const searchBtn = header.createEl("button", { text: "🔍", cls: "kan-refresh", attr: { "aria-label": "Search" } });
    const refreshBtn = header.createEl("button", { text: "↻", cls: "kan-refresh", attr: { "aria-label": "Refresh" } });

    const filters = el.createDiv({ cls: "kan-filters" });
    const dueSel = filters.createEl("select", { cls: "kan-select", attr: { "aria-label": "Due filter" } });
    dueSel.createEl("option", { text: "All due dates", value: "" });
    for (const d of DUE_FILTERS) {
      const o = dueSel.createEl("option", { text: d, value: d });
      if (this.filterDue === d) o.selected = true;
    }
    dueSel.onchange = async () => {
      this.filterDue = dueSel.value;
      this.plugin.settings.boardDueFilter = dueSel.value;
      await this.plugin.saveSettings();
      await renderBoard();
    };
    const archivedToggle = filters.createEl("label", { cls: "kan-filter-check" });
    const archCb = archivedToggle.createEl("input", { attr: { type: "checkbox" } });
    archCb.checked = !!this.plugin.settings.showArchivedBoards;
    archivedToggle.appendText(" Archived");
    archCb.onchange = async () => {
      this.plugin.settings.showArchivedBoards = archCb.checked;
      await this.plugin.saveSettings();
      await loadBoards();
    };

    const body = el.createDiv({ cls: "kan-body" });

    const loadWorkspaces = async () => {
      try {
        const wss = await this.plugin.client.getWorkspaces();
        wsSelect.empty();
        for (const w of wss) {
          const opt = wsSelect.createEl("option", { text: w.name || w.publicId });
          opt.value = w.publicId;
        }
        if (this.plugin.settings.workspaceId) wsSelect.value = this.plugin.settings.workspaceId;
        else if (wss.length) { this.plugin.settings.workspaceId = wss[0].publicId; await this.plugin.saveSettings(); }
      } catch (e) { console.error(e); }
    };
    wsSelect.onchange = async () => {
      this.plugin.settings.workspaceId = wsSelect.value;
      await this.plugin.saveSettings();
      this.selectedBoardId = null;
      await loadBoards();
    };
    typeSelect.onchange = async () => {
      this.plugin.settings.boardListType = typeSelect.value;
      await this.plugin.saveSettings();
      this.selectedBoardId = null;
      await loadBoards();
    };

    const renderBoard = async () => {
      body.empty();
      body.setText("Loading…");
      let board;
      try { board = await this.plugin.client.getBoard(this.selectedBoardId, this.boardFilters()); }
      catch (e) { body.setText("Error: " + e.message); return; }
      this.currentBoard = board;
      body.empty();

      // label/member filter chips from board
      const chipRow = body.createDiv({ cls: "kan-filters" });
      chipRow.createSpan({ text: "Labels: ", cls: "kan-filter-label" });
      for (const l of board.labels || []) {
        const on = this.filterLabelIds.includes(l.publicId);
        const b = chipRow.createEl("button", { cls: "kan-label" + (on ? " is-on" : ""), text: l.name });
        if (l.colourCode) b.style.background = l.colourCode + "33";
        b.onclick = async () => {
          if (on) this.filterLabelIds = this.filterLabelIds.filter((id) => id !== l.publicId);
          else this.filterLabelIds.push(l.publicId);
          await renderBoard();
        };
      }
      const mems = (board.workspace && board.workspace.members) || [];
      if (mems.length) {
        chipRow.createSpan({ text: " Members: ", cls: "kan-filter-label" });
        for (const m of mems) {
          const on = this.filterMemberIds.includes(m.publicId);
          const name = (m.user && m.user.name) || m.email || m.publicId;
          const b = chipRow.createEl("button", { cls: on ? "is-on" : "", text: name.split(" ")[0] });
          b.onclick = async () => {
            if (on) this.filterMemberIds = this.filterMemberIds.filter((id) => id !== m.publicId);
            else this.filterMemberIds.push(m.publicId);
            await renderBoard();
          };
        }
      }

      const cols = body.createDiv({ cls: "kan-columns" });
      const lists = board.lists || [];
      lists.forEach((list, listIndex) => {
        const col = cols.createDiv({ cls: "kan-col", attr: { draggable: "true" } });
        const titleRow = col.createDiv({ cls: "kan-col-title-row" });
        titleRow.createDiv({ cls: "kan-col-title", text: `${list.name} (${(list.cards || []).length})` });
        titleRow.createEl("button", { text: "🗑", cls: "kan-icon-btn", attr: { title: "Delete list" } }).onclick = (ev) => {
          ev.stopPropagation();
          new KanConfirmModal(this.app, "Delete list", `Delete list "${list.name}" and its cards relationship?`, async () => {
            await this.plugin.client.deleteList(list.publicId);
            new Notice("List deleted.");
            await renderBoard();
          }).open();
        };

        col.addEventListener("dragstart", (ev) => {
          if (ev.target.closest && ev.target.closest(".kan-card")) return;
          ev.dataTransfer.setData("text/kan-list", list.publicId);
          ev.dataTransfer.setData("text/kan-list-index", String(listIndex));
        });
        col.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          if (ev.dataTransfer.types.includes("text/kan-list") || ev.dataTransfer.getData("text/kan-list"))
            col.addClass("kan-drop-target");
        });
        col.addEventListener("dragleave", () => col.removeClass("kan-drop-target"));
        col.addEventListener("drop", async (ev) => {
          ev.preventDefault();
          col.removeClass("kan-drop-target");
          const listId = ev.dataTransfer.getData("text/kan-list");
          const cardId = ev.dataTransfer.getData("text/kan-card");
          if (listId && listId !== list.publicId) {
            try {
              await this.plugin.client.updateList(listId, { index: listIndex });
              await renderBoard();
            } catch (e) { new Notice("Kan error: " + e.message, 8000); }
            return;
          }
          if (!cardId) return;
          try {
            await this.plugin.client.updateCard(cardId, { listPublicId: list.publicId });
            new Notice(`Moved to "${list.name}"`);
            await renderBoard();
          } catch (e) { new Notice("Kan error: " + e.message, 8000); }
        });

        for (const card of list.cards || []) {
          const c = col.createDiv({ cls: "kan-card", attr: { draggable: "true" } });
          c.addEventListener("dragstart", (ev) => {
            ev.stopPropagation();
            ev.dataTransfer.setData("text/kan-card", card.publicId);
            c.addClass("kan-dragging");
          });
          c.addEventListener("dragend", () => c.removeClass("kan-dragging"));
          c.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.stopPropagation(); c.addClass("kan-drop-target"); });
          c.addEventListener("dragleave", () => c.removeClass("kan-drop-target"));
          c.addEventListener("drop", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            c.removeClass("kan-drop-target");
            const draggedId = ev.dataTransfer.getData("text/kan-card");
            if (!draggedId || draggedId === card.publicId) return;
            try {
              await this.plugin.client.updateCard(draggedId, { listPublicId: list.publicId, index: card.index });
              await renderBoard();
            } catch (e) { new Notice("Kan error: " + e.message, 8000); }
          });
          c.addEventListener("click", () => new KanCardModal(this.app, this.plugin, card.publicId).open());
          c.createDiv({ cls: "kan-card-title", text: card.title });
          if (card.dueDate) c.createDiv({ cls: "kan-card-due", text: "Due: " + String(card.dueDate).slice(0, 10) });
          if ((card.members || []).length)
            c.createDiv({ cls: "kan-card-due", text: "👤 " + card.members.map((m) => ((m.user && m.user.name) || m.email || "").split(" ")[0]).join(", ").slice(0, 40) });
          const checklists = card.checklists || [];
          if (checklists.length) {
            const total = checklists.reduce((n, cl) => n + (cl.items || []).length, 0);
            const done = checklists.reduce((n, cl) => n + (cl.items || []).filter((i) => i.completed).length, 0);
            if (total) c.createDiv({ cls: "kan-card-due", text: `☑ ${done}/${total}` });
          }
          if ((card.attachments || []).length)
            c.createDiv({ cls: "kan-card-due", text: `📎 ${card.attachments.length}` });
          if ((card.labels || []).length) {
            const lbls = c.createDiv({ cls: "kan-card-labels" });
            for (const l of card.labels) {
              const span = lbls.createSpan({ cls: "kan-label", text: l.name });
              if (l.colourCode) span.style.background = l.colourCode + "33";
            }
          }
        }
      });
    };

    const loadBoards = async () => {
      const ws = this.plugin.settings.workspaceId;
      if (!ws) { body.setText("Set workspace in Settings → Kan Sync."); return; }
      const opts = { type: this.plugin.settings.boardListType || "regular" };
      if (this.plugin.settings.showArchivedBoards) opts.archived = true;
      try { this.boards = await this.plugin.client.getBoards(ws, opts); }
      catch (e) { body.setText("Error: " + e.message); return; }
      select.empty();
      for (const b of this.boards) {
        const label = (b.favorite ? "★ " : "") + b.name + (b.isArchived ? " (archived)" : "");
        const opt = select.createEl("option", { text: label });
        opt.value = b.publicId;
      }
      if (this.boards.length) {
        if (!this.boards.find((b) => b.publicId === this.selectedBoardId)) this.selectedBoardId = this.boards[0].publicId;
        select.value = this.selectedBoardId;
        await renderBoard();
      } else body.setText("No boards in this workspace yet.");
    };

    menuBtn.onclick = () => this.openBoardMenu();
    select.onchange = async () => { this.selectedBoardId = select.value; await renderBoard(); };
    refreshBtn.onclick = async () => { await loadWorkspaces(); await loadBoards(); };
    searchBtn.onclick = () => new KanSearchModal(this.app, this.plugin).open();
    this.reload = loadBoards;
    this.renderBoard = renderBoard;
    await loadWorkspaces();
    await loadBoards();
  }

  openBoardMenu() {
    const board = this.currentBoard || this.boards.find((b) => b.publicId === this.selectedBoardId);
    if (!board && !this.selectedBoardId) { new Notice("Select a board first."); return; }
    const id = this.selectedBoardId;
    const name = (board && board.name) || id;
    new KanPromptModal(this.app, "Board actions: " + name, [
      { key: "action", label: "Action", type: "select", value: "favorite", options: [
        { value: "favorite", label: "Toggle favorite" },
        { value: "archive", label: "Toggle archive" },
        { value: "visibility", label: "Toggle visibility (public/private)" },
        { value: "slug", label: "Set slug" },
        { value: "move", label: "Move to another workspace" },
        { value: "template", label: "Save as template board" },
        { value: "fromTemplate", label: "Create new board from this (as source)" },
        { value: "delete", label: "Delete board" },
      ]},
      { key: "slug", label: "Slug (for Set slug)", value: (board && board.slug) || "", placeholder: "my-board" },
      { key: "targetWs", label: "Target workspace ID (for Move)", value: "", placeholder: "workspace publicId" },
      { key: "newName", label: "New board name (from template)", value: name + " copy" },
    ], async (v) => {
      const client = this.plugin.client;
      if (v.action === "favorite") {
        await client.updateBoard(id, { favorite: !(board && board.favorite) });
        new Notice("Favorite updated.");
      } else if (v.action === "archive") {
        await client.updateBoard(id, { isArchived: !(board && board.isArchived) });
        new Notice("Archive updated.");
      } else if (v.action === "visibility") {
        const next = (board && board.visibility) === "public" ? "private" : "public";
        await client.updateBoard(id, { visibility: next });
        new Notice("Visibility: " + next);
      } else if (v.action === "slug") {
        if (!v.slug.trim()) { new Notice("Enter a slug."); return; }
        try { await client.checkBoardSlug(id, v.slug.trim()); } catch (e) { /* may 400 if taken */ }
        await client.updateBoard(id, { slug: v.slug.trim() });
        new Notice("Slug updated.");
      } else if (v.action === "move") {
        if (!v.targetWs.trim()) { new Notice("Enter target workspace ID."); return; }
        await client.moveBoard(id, v.targetWs.trim());
        new Notice("Board moved.");
      } else if (v.action === "template") {
        await client.createBoard(this.plugin.settings.workspaceId, (v.newName || name) + " template", (board.lists || []).map((l) => l.name), {
          type: "template",
          sourceBoardPublicId: id,
          labels: (board.labels || []).map((l) => l.name),
        });
        new Notice("Template board created.");
      } else if (v.action === "fromTemplate") {
        await client.createBoard(this.plugin.settings.workspaceId, v.newName || (name + " copy"), [], {
          type: "regular",
          sourceBoardPublicId: id,
        });
        new Notice("Board created from template/source.");
      } else if (v.action === "delete") {
        new KanConfirmModal(this.app, "Delete board", `Permanently delete board "${name}"?`, async () => {
          await client.deleteBoard(id);
          this.selectedBoardId = null;
          new Notice("Board deleted.");
          if (this.reload) await this.reload();
        }).open();
        return;
      }
      if (this.reload) await this.reload();
    }).open();
  }
}

/* ---------------- main plugin ---------------- */

class KanSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.client = new KanClient(() => this.settings);
    this.lastAutoSync = 0;

    this.registerView(VIEW_TYPE_KAN, (leaf) => new KanBoardView(leaf, this));
    this.addRibbonIcon("layout-dashboard", "Open Kan boards", () => this.activateView());

    this.addCommand({ id: "open-board-view", name: "Open board view", callback: () => this.activateView() });
    this.addCommand({ id: "push-checklist", name: "Push active note's checklist to Kan", callback: () => this.pushChecklist() });
    this.addCommand({ id: "pull-status", name: "Pull Kan board status into active note", callback: () => this.pullStatus() });
    this.addCommand({ id: "full-sync", name: "Full sync active note (push + pull)", callback: async () => { await this.pushChecklist(); await this.pullStatus(); } });
    this.addCommand({ id: "search", name: "Search boards and cards", callback: () => new KanSearchModal(this.app, this).open() });
    this.addCommand({
      id: "comment-card",
      name: "Comment on linked card (cursor line)",
      editorCallback: (editor) => {
        const line = editor.getLine(editor.getCursor().line);
        const id = (line.match(MARKER_RE) || [])[1];
        if (!id) { new Notice("No %%kan:ID%% marker on this line — push first."); return; }
        new KanCommentModal(this.app, this, id, cleanText(line.replace(/^\s*-\s*\[.\]\s*/, ""))).open();
      },
    });
    this.addCommand({
      id: "attach-file",
      name: "Attach a file to linked card (cursor line)",
      editorCallback: (editor) => {
        const id = this.markerOnCursorLine(editor);
        if (!id) { new Notice("No %%kan:ID%% marker on this line — push first."); return; }
        this.attachFileToCard(id);
      },
    });
    this.addCommand({
      id: "attach-note",
      name: "Attach active note to linked card (cursor line)",
      editorCallback: (editor) => {
        const id = this.markerOnCursorLine(editor);
        if (!id) { new Notice("No %%kan:ID%% marker on this line — push first."); return; }
        this.attachActiveNoteToCard(id);
      },
    });
    this.addCommand({
      id: "duplicate-card",
      name: "Duplicate linked card (cursor line)",
      editorCallback: async (editor) => {
        const id = this.markerOnCursorLine(editor);
        if (!id) { new Notice("No %%kan:ID%% marker on this line — push first."); return; }
        try {
          const card = await this.client.getCard(id);
          new KanDuplicateModal(this.app, this, card).open();
        } catch (e) { new Notice("Kan error: " + e.message, 8000); console.error(e); }
      },
    });
    this.addCommand({
      id: "delete-card",
      name: "Delete linked card (cursor line)",
      editorCallback: async (editor) => {
        if (!this.settings.allowDeletes) {
          new Notice("Enable “Allow deletes on push” in Settings → Kan Sync first.");
          return;
        }
        const lineNo = editor.getCursor().line;
        const line = editor.getLine(lineNo);
        const id = (line.match(MARKER_RE) || [])[1];
        if (!id) { new Notice("No %%kan:ID%% marker on this line."); return; }
        new KanConfirmModal(this.app, "Delete card", "Delete this card in Kan?", async () => {
          await this.client.deleteCard(id);
          const cleaned = line.replace(MARKER_RE, "").replace(/\s+$/, "");
          editor.setLine(lineNo, cleaned);
          new Notice("Card deleted in Kan.");
        }).open();
      },
    });
    this.addCommand({
      id: "test-connection",
      name: "Test connection",
      callback: () => this.testConnection(),
    });
    this.addCommand({
      id: "import-trello",
      name: "Import boards from Trello",
      callback: () => new KanImportModal(this.app, this, "trello").open(),
    });
    this.addCommand({
      id: "import-github",
      name: "Import projects from GitHub",
      callback: () => new KanImportModal(this.app, this, "github").open(),
    });
    this.addCommand({
      id: "invite-member",
      name: "Invite member to workspace",
      callback: () => {
        new KanPromptModal(this.app, "Invite member", [
          { key: "email", label: "Email", value: "", placeholder: "user@example.com" },
        ], async (v) => {
          await this.client.inviteMember(this.settings.workspaceId, v.email.trim());
          new Notice("Invite sent.");
        }).open();
      },
    });
    this.addCommand({
      id: "copy-invite-link",
      name: "Copy workspace invite link",
      callback: async () => {
        try {
          let link = await this.client.getInviteLink(this.settings.workspaceId);
          if (!link || !(link.url || link.code || link.inviteCode)) {
            link = await this.client.createInviteLink(this.settings.workspaceId);
          }
          const text = link.url || link.code || link.inviteCode || JSON.stringify(link);
          await navigator.clipboard.writeText(String(text));
          new Notice("Invite link copied.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      },
    });
    this.addCommand({
      id: "archive-board",
      name: "Archive / unarchive board for active note",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("No active note."); return; }
        const id = this.boardIdForFile(file);
        if (!id) { new Notice("Push once to store kan_board_id."); return; }
        try {
          const board = await this.client.getBoard(id);
          await this.client.updateBoard(id, { isArchived: !board.isArchived });
          new Notice(board.isArchived ? "Board unarchived." : "Board archived.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      },
    });
    this.addCommand({
      id: "favorite-board",
      name: "Favorite / unfavorite board for active note",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("No active note."); return; }
        const id = this.boardIdForFile(file);
        if (!id) { new Notice("Push once to store kan_board_id."); return; }
        try {
          const board = await this.client.getBoard(id);
          await this.client.updateBoard(id, { favorite: !board.favorite });
          new Notice(board.favorite ? "Removed favorite." : "Board favorited.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      },
    });
    this.addCommand({
      id: "create-from-template",
      name: "Create board from template (active note)",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("No active note."); return; }
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const templateId = fm && fm.kan_template_id;
        if (!templateId) { new Notice("Set kan_template_id in frontmatter."); return; }
        const name = this.boardNameForFile(file);
        try {
          const created = await this.client.createBoard(this.settings.workspaceId, name, [], {
            type: "regular",
            sourceBoardPublicId: templateId,
          });
          await this.ensureBoardIdFrontmatter(file, created.publicId, created.slug);
          new Notice("Board created from template.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      },
    });
    this.addCommand({
      id: "save-as-template",
      name: "Save linked board as template",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("No active note."); return; }
        const id = this.boardIdForFile(file);
        if (!id) { new Notice("Push once to store kan_board_id."); return; }
        try {
          const board = await this.client.getBoard(id);
          await this.client.createBoard(this.settings.workspaceId, board.name + " template", (board.lists || []).map((l) => l.name), {
            type: "template",
            sourceBoardPublicId: id,
            labels: (board.labels || []).map((l) => l.name),
          });
          new Notice("Template created.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      },
    });
    this.addCommand({
      id: "open-kan-admin",
      name: "Open Kan Sync settings (admin)",
      callback: () => {
        // Open Obsidian settings focused on this plugin's tab
        // @ts-ignore
        this.app.setting.open();
        // @ts-ignore
        this.app.setting.openTabById(this.manifest.id);
      },
    });
    this.addCommand({
      id: "show-stats",
      name: "Show Kan instance stats",
      callback: async () => {
        try {
          const s = await this.client.stats();
          console.log("Kan stats:", s);
          const bits = [];
          if (s && typeof s === "object") {
            for (const k of Object.keys(s).slice(0, 6)) bits.push(`${k}=${s[k]}`);
          }
          new Notice(bits.length ? `Kan stats: ${bits.join(", ")}` : "Kan stats logged to console.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      },
    });
    this.addCommand({
      id: "lookup-invite",
      name: "Lookup invite code",
      callback: () => {
        new KanPromptModal(this.app, "Lookup invite", [
          { key: "code", label: "Invite code", value: "" },
        ], async (v) => {
          const info = await this.client.getInviteInfo(v.code.trim());
          console.log("Kan invite:", info);
          new Notice("Invite info logged to console.");
        }).open();
      },
    });

    this.addSettingTab(new KanSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.autoTick(), 60 * 1000));
  }

  onunload() {}

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  async autoTick() {
    const mins = Number(this.settings.autoSyncMinutes) || 0;
    if (mins <= 0) return;
    if (Date.now() - this.lastAutoSync < mins * 60 * 1000) return;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !fm.kan_board) return;
    this.lastAutoSync = Date.now();
    try { await this.pullStatus({ silent: true }); } catch (e) { console.error("Kan auto-sync:", e); }
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_KAN);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return existing[0].view; }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_KAN, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async openBoard(boardId) {
    const view = await this.activateView();
    if (view && view instanceof KanBoardView) {
      view.selectedBoardId = boardId;
      await view.render();
    }
  }

  boardNameForFile(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return (fm && fm.kan_board) || file.basename;
  }

  boardIdForFile(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return (fm && fm.kan_board_id) || null;
  }

  boardSlugForFile(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return (fm && fm.kan_board_slug) || null;
  }

  workspaceSlugForFile(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return (fm && fm.kan_workspace_slug) || this.settings.workspaceSlug || null;
  }

  async ensureBoardIdFrontmatter(file, boardId, boardSlug, workspaceSlug) {
    const existing = this.boardIdForFile(file);
    const existingSlug = this.boardSlugForFile(file);
    const existingWs = this.app.metadataCache.getFileCache(file)?.frontmatter?.kan_workspace_slug;
    const wsSlug = workspaceSlug || this.settings.workspaceSlug || null;
    if (
      existing === boardId
      && (!boardSlug || existingSlug === boardSlug)
      && (!wsSlug || existingWs === wsSlug)
    ) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.kan_board_id = boardId;
      if (boardSlug) fm.kan_board_slug = boardSlug;
      if (wsSlug) fm.kan_workspace_slug = wsSlug;
    });
  }

  async findBoardByName(name) {
    const boards = await this.client.getBoards(this.settings.workspaceId);
    return boards.find((b) => b.name.toLowerCase() === name.toLowerCase()) || null;
  }

  async resolveBoard(file, boardName, listNames) {
    const id = this.boardIdForFile(file);
    if (id) {
      try {
        const board = await this.client.getBoard(id);
        if (board && board.publicId) return { stub: { publicId: board.publicId, name: board.name }, board };
      } catch (e) {
        console.warn("Kan: stored kan_board_id not found, falling back to slug/name", e);
      }
    }
    const slug = this.boardSlugForFile(file);
    const wsSlug = this.workspaceSlugForFile(file);
    if (slug && wsSlug) {
      try {
        const board = await this.client.getBoardBySlug(wsSlug, slug);
        if (board && board.publicId) return { stub: { publicId: board.publicId, name: board.name }, board };
      } catch (e) {
        console.warn("Kan: kan_board_slug lookup failed, falling back to name", e);
      }
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const templateId = fm && fm.kan_template_id;
    let stub = await this.findBoardByName(boardName);
    if (!stub) {
      const created = await this.client.createBoard(this.settings.workspaceId, boardName, listNames || [], {
        type: "regular",
        sourceBoardPublicId: templateId || undefined,
        labels: Array.isArray(fm && fm.kan_labels) ? fm.kan_labels : [],
      });
      stub = { publicId: created.publicId, name: boardName };
    }
    return { stub, board: null };
  }

  async ensureLabels(board, tagNames) {
    const map = {};
    const byId = {};
    for (const l of board.labels || []) {
      map[l.name.toLowerCase()] = l.publicId;
      byId[l.publicId] = l;
    }
    for (const tag of tagNames) {
      const key = tag.toLowerCase();
      const wantColour = labelColour(tag);
      if (!map[key]) {
        try {
          const created = await this.client.createLabel(board.publicId, tag, wantColour);
          map[key] = created.publicId;
        } catch (e) { console.error("Kan label create failed:", tag, e); }
      } else {
        // Sync name casing / colour when they drift
        const id = map[key];
        const existing = byId[id];
        if (existing && (existing.name !== tag || existing.colourCode !== wantColour)) {
          try {
            await this.client.updateLabel(id, { name: tag.slice(0, 36), colourCode: wantColour });
          } catch (e) { console.warn("Kan label update:", e); }
        }
      }
    }
    return map;
  }

  async syncSubtasksForCard(card, children) {
    // Group children by checklist name; sync each checklist with add/rename/reorder/complete/delete
    const defaultName = this.settings.subtaskChecklistName || "Subtasks";
    const groups = {};
    for (const child of children) {
      const name = child.checklistName || defaultName;
      if (!groups[name]) groups[name] = [];
      groups[name].push(child);
    }
    // If no children but allowDeletes, still clean default checklist
    if (!children.length && this.settings.allowDeletes) {
      groups[defaultName] = [];
    }

    let added = 0, completed = 0, removed = 0, renamed = 0, reordered = 0;

    for (const clName of Object.keys(groups)) {
      const kids = groups[clName];
      let checklist = (card.checklists || []).find((c) => c.name.toLowerCase() === clName.toLowerCase());
      let checklistId = checklist ? checklist.publicId : null;
      const existingItems = [...((checklist && checklist.items) || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const used = new Set();
      const assignments = new Array(kids.length).fill(null);

      // Pass 1: match by normalized title
      for (let idx = 0; idx < kids.length; idx++) {
        const key = normTitle(kids[idx].title);
        const hit = existingItems.find((i) => !used.has(i.publicId) && normTitle(i.title) === key);
        if (hit) { assignments[idx] = hit; used.add(hit.publicId); }
      }
      // Pass 2: positional match for renames (same index among leftovers)
      const leftoverKids = [];
      const leftoverExisting = existingItems.filter((i) => !used.has(i.publicId));
      for (let idx = 0; idx < kids.length; idx++) {
        if (!assignments[idx]) leftoverKids.push(idx);
      }
      for (let i = 0; i < leftoverKids.length && i < leftoverExisting.length; i++) {
        const kidIdx = leftoverKids[i];
        assignments[kidIdx] = leftoverExisting[i];
        used.add(leftoverExisting[i].publicId);
      }

      const matchedIds = new Set();
      for (let idx = 0; idx < kids.length; idx++) {
        const child = kids[idx];
        const existing = assignments[idx];
        if (existing) {
          matchedIds.add(existing.publicId);
          const patch = {};
          if (child.done && !existing.completed) { patch.completed = true; completed++; }
          if (existing.title !== child.title) { patch.title = child.title.slice(0, 500); renamed++; }
          if (existing.index === undefined || existing.index !== idx) { patch.index = idx; reordered++; }
          if (Object.keys(patch).length) {
            await this.client.updateChecklistItem(existing.publicId, patch);
          }
          continue;
        }
        if (!checklistId) {
          const created = await this.client.createChecklist(card.publicId, clName);
          checklistId = created.publicId;
          if (!card.checklists) card.checklists = [];
          card.checklists.push({ publicId: checklistId, name: clName, items: [] });
        }
        const ni = await this.client.addChecklistItem(checklistId, child.title);
        added++;
        if (ni && ni.publicId) {
          matchedIds.add(ni.publicId);
          const patch = { index: idx };
          if (child.done) { patch.completed = true; completed++; }
          await this.client.updateChecklistItem(ni.publicId, patch);
        }
      }

      if (this.settings.allowDeletes && checklist) {
        for (const i of checklist.items || []) {
          if (!matchedIds.has(i.publicId)) {
            await this.client.deleteChecklistItem(i.publicId);
            removed++;
          }
        }
      }
    }
    return { added, completed, removed, renamed, reordered };
  }

  resolveMention(mention, wsMembers) {
    // match @handle against workspace member names and emails (first/whole name or email prefix)
    const q = mention.toLowerCase().replace(/[._-]/g, " ");
    for (const m of wsMembers || []) {
      const name = ((m.user && m.user.name) || "").toLowerCase();
      const email = (m.email || "").toLowerCase();
      if (!name && !email) continue;
      if (name === q || name.split(" ").includes(q) || name.replace(/\s+/g, "") === q.replace(/\s+/g, "")) return m;
      if (email.split("@")[0] === mention.toLowerCase()) return m;
    }
    return null;
  }

  async syncMembersForCard(cardPublicId, currentMemberIds, mentions, wsMembers, existingMembers) {
    // assign mentioned members; when allowDeletes, remove members not mentioned
    let assigned = 0, removed = 0;
    const wantIds = new Set();
    for (const mention of mentions) {
      const member = this.resolveMention(mention, wsMembers);
      if (!member) { console.warn(`Kan: no workspace member matches @${mention}`); continue; }
      wantIds.add(member.publicId);
      if (currentMemberIds.has(member.publicId)) continue;
      await this.client.toggleCardMember(cardPublicId, member.publicId);
      currentMemberIds.add(member.publicId);
      assigned++;
    }
    if (this.settings.allowDeletes && existingMembers) {
      for (const m of existingMembers) {
        if (!wantIds.has(m.publicId) && currentMemberIds.has(m.publicId)) {
          await this.client.toggleCardMember(cardPublicId, m.publicId);
          currentMemberIds.delete(m.publicId);
          removed++;
        }
      }
    }
    return { assigned, removed };
  }

  resolveMentionIds(mentions, wsMembers) {
    const ids = [];
    for (const mention of mentions) {
      const member = this.resolveMention(mention, wsMembers);
      if (member) ids.push(member.publicId);
      else console.warn(`Kan: no workspace member matches @${mention}`);
    }
    return ids;
  }

  markerOnCursorLine(editor) {
    const line = editor.getLine(editor.getCursor().line);
    return (line.match(MARKER_RE) || [])[1] || null;
  }

  async attachDataToCard(cardId, filename, contentType, data) {
    if (data.byteLength > MAX_ATTACHMENT) throw new Error("File exceeds the 50 MB attachment limit.");
    const { url, key } = await this.client.getAttachmentUploadUrl(cardId, filename, contentType, data.byteLength);
    await this.client.uploadToPresigned(url, data, contentType);
    await this.client.confirmAttachment(cardId, key, filename, contentType, data.byteLength);
  }

  attachFileToCard(cardId) {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        new Notice(`Uploading "${file.name}"…`);
        const data = await file.arrayBuffer();
        await this.attachDataToCard(cardId, file.name, file.type || "application/octet-stream", data);
        new Notice(`Attached "${file.name}".`);
      } catch (e) { new Notice("Kan error: " + e.message, 8000); console.error(e); }
    };
    input.click();
  }

  async attachActiveNoteToCard(cardId) {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active note."); return; }
    try {
      const content = await this.app.vault.read(file);
      const data = new TextEncoder().encode(content).buffer;
      await this.attachDataToCard(cardId, file.name, "text/markdown", data);
      new Notice(`Attached note "${file.name}" to card.`);
    } catch (e) { new Notice("Kan error: " + e.message, 8000); console.error(e); }
  }

  async saveAttachmentToVault(attachment) {
    const name = attachment.originalFilename || attachment.filename || attachment.s3Key || "attachment.bin";
    const url = attachment.url;
    if (!url) throw new Error("Attachment has no download URL.");
    const res = await requestUrl({ url, method: "GET", throw: false });
    if (res.status >= 400) throw new Error(`Download failed (${res.status})`);
    const folder = "Kan Sync Attachments";
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
    let path = `${folder}/${name}`;
    let n = 1;
    while (await this.app.vault.adapter.exists(path)) {
      const parts = name.split(".");
      const ext = parts.length > 1 ? "." + parts.pop() : "";
      path = `${folder}/${parts.join(".")}-${n}${ext}`;
      n++;
    }
    const data = res.arrayBuffer;
    await this.app.vault.createBinary(path, data);
    return path;
  }

  async testConnection() {
    try {
      const health = await this.client.health();
      let me = null;
      try { me = await this.client.getMe(); } catch (e) { /* optional */ }
      const who = me && (me.name || me.email || me.publicId);
      new Notice(`Kan OK${who ? " — " + who : ""}${health && health.status ? " (" + health.status + ")" : ""}.`);
      console.log("Kan health:", health, "user:", me);
    } catch (e) { new Notice("Kan error: " + e.message, 8000); }
  }

  async pushChecklist() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active note."); return; }
    if (!this.settings.workspaceId) { new Notice("Set workspace in Settings → Kan Sync."); return; }

    const content = await this.app.vault.read(file);
    const { sections, lines } = parseNote(content, this.settings.defaultListName, this.settings.subtaskChecklistName);
    if (!sections.length) { new Notice("No checklist items found."); return; }

    const boardName = this.boardNameForFile(file);
    new Notice(`Kan: syncing "${boardName}"…`);

    try {
      let { stub, board: preloaded } = await this.resolveBoard(file, boardName, sections.map((s) => s.name));
      let board = preloaded || await this.client.getBoard(stub.publicId);

      // Board rename when note's mapped name differs from Kan board name
      if (this.settings.renameBoard && board.name && board.name.toLowerCase() !== boardName.toLowerCase()) {
        await this.client.updateBoard(board.publicId, { name: boardName });
        board = await this.client.getBoard(board.publicId);
      }
      await this.ensureBoardIdFrontmatter(file, board.publicId, board.slug);

      // Ensure lists exist; optionally rename lists that hold this section's cards
      const listMap = {};
      const listById = {};
      for (const l of board.lists || []) {
        listMap[l.name.toLowerCase()] = l.publicId;
        listById[l.publicId] = l;
      }
      for (const s of sections) {
        if (!listMap[s.name.toLowerCase()]) {
          // try rename: if section cards all live in one differently named list
          if (this.settings.renameLists) {
            const cardListIds = new Set();
            for (const item of s.items) {
              if (!item.kanId) continue;
              for (const l of board.lists || []) {
                if ((l.cards || []).some((c) => c.publicId === item.kanId)) cardListIds.add(l.publicId);
              }
            }
            if (cardListIds.size === 1) {
              const oldId = [...cardListIds][0];
              const old = listById[oldId];
              if (old && old.name.toLowerCase() !== s.name.toLowerCase()) {
                await this.client.updateList(oldId, { name: s.name });
                delete listMap[old.name.toLowerCase()];
                listMap[s.name.toLowerCase()] = oldId;
                old.name = s.name;
                continue;
              }
            }
          }
          const nl = await this.client.createList(board.publicId, s.name);
          listMap[s.name.toLowerCase()] = nl.publicId;
        }
      }

      // Refresh board after list changes
      board = await this.client.getBoard(board.publicId);
      for (const l of board.lists || []) listMap[l.name.toLowerCase()] = l.publicId;

      // Reorder lists to match heading order in the note
      if (this.settings.reorderLists) {
        for (let i = 0; i < sections.length; i++) {
          const lid = listMap[sections[i].name.toLowerCase()];
          if (lid) {
            try { await this.client.updateList(lid, { index: i }); } catch (e) { console.warn("Kan list reorder:", e); }
          }
        }
        board = await this.client.getBoard(board.publicId);
        for (const l of board.lists || []) listMap[l.name.toLowerCase()] = l.publicId;
      }

      // Opt-in: delete lists that have no matching heading and no cards from this note
      if (this.settings.allowDeletes) {
        const wantLists = new Set(sections.map((s) => s.name.toLowerCase()));
        for (const l of board.lists || []) {
          if (wantLists.has(l.name.toLowerCase())) continue;
          if ((l.cards || []).length === 0) {
            try { await this.client.deleteList(l.publicId); } catch (e) { console.warn("Kan list delete:", e); }
          }
        }
        board = await this.client.getBoard(board.publicId);
        for (const l of board.lists || []) listMap[l.name.toLowerCase()] = l.publicId;
      }

      const doneNames = this.settings.doneLists.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const firstDoneList = (board.lists || []).find((l) => doneNames.includes(l.name.toLowerCase()));

      const cardsById = {};
      const cardsByTitle = {};
      const cardListName = {};
      for (const l of board.lists || [])
        for (const c of l.cards || []) {
          cardsById[c.publicId] = c;
          cardsByTitle[normTitle(c.title)] = c;
          cardListName[c.publicId] = l.name.toLowerCase();
        }

      const allTags = this.settings.syncTags ? [...new Set(sections.flatMap((s) => s.items.flatMap((i) => i.tags)))] : [];
      const labelMap = allTags.length ? await this.ensureLabels(board, allTags) : {};
      // refresh labels after ensure
      board = allTags.length ? await this.client.getBoard(board.publicId) : board;
      for (const l of board.labels || []) labelMap[l.name.toLowerCase()] = l.publicId;
      const wsMembers = (board.workspace && board.workspace.members) || [];

      let created = 0, updated = 0, adopted = 0, moved = 0, subAdded = 0, subCompleted = 0, labeled = 0, assigned = 0;
      let deleted = 0, descUpdated = 0, clearedDue = 0, removedLabels = 0, removedMembers = 0, removedSubs = 0;
      let subRenamed = 0, subReordered = 0;
      const markers = [];
      const noteCardIds = new Set();

      for (const s of sections) {
        const listId = listMap[s.name.toLowerCase()];
        for (const item of s.items) {
          const existing = item.kanId ? cardsById[item.kanId] : cardsByTitle[normTitle(item.title)];

          if (existing) {
            noteCardIds.add(existing.publicId);
            if (!item.kanId && this.settings.useIdMarkers) { markers.push({ lineNo: item.lineNo, id: existing.publicId }); adopted++; }

            const patch = {};
            if (item.kanId && normTitle(existing.title) !== normTitle(item.title)) patch.title = item.title;
            const existingDue = existing.dueDate ? String(existing.dueDate).slice(0, 10) : null;
            if (item.due && item.due !== existingDue) patch.dueDate = toIsoDue(item.due);
            else if (!item.due && existingDue) { patch.dueDate = null; clearedDue++; }

            if (this.settings.syncDescription) {
              const wantDesc = buildCardDescription(file.path, item.description);
              if ((existing.description || "") !== wantDesc) {
                patch.description = wantDesc;
                descUpdated++;
              }
            }

            // move card to the section's list if heading changed
            if (listId && cardListName[existing.publicId] !== s.name.toLowerCase()
              && !(item.done && this.settings.moveDoneCards && firstDoneList)) {
              patch.listPublicId = listId;
            }

            if (Object.keys(patch).length) { await this.client.updateCard(existing.publicId, patch); updated++; }

            // labels: add (retro) and optionally remove
            if (this.settings.syncTags) {
              const have = new Set((existing.labels || []).map((l) => l.name.toLowerCase()));
              const want = new Set(item.tags.map((t) => t.toLowerCase()));
              if (this.settings.retroLabel) {
                for (const tag of item.tags) {
                  if (!have.has(tag.toLowerCase()) && labelMap[tag.toLowerCase()]) {
                    await this.client.toggleCardLabel(existing.publicId, labelMap[tag.toLowerCase()]);
                    labeled++;
                    have.add(tag.toLowerCase());
                  }
                }
              }
              if (this.settings.allowDeletes) {
                for (const l of existing.labels || []) {
                  if (!want.has(l.name.toLowerCase())) {
                    await this.client.toggleCardLabel(existing.publicId, l.publicId);
                    removedLabels++;
                  }
                }
              }
            }

            // @mentions → card members
            if (this.settings.syncMembers) {
              const have = new Set((existing.members || []).map((m) => m.publicId));
              const r = await this.syncMembersForCard(
                existing.publicId, have, item.mentions, wsMembers, existing.members || []
              );
              assigned += r.assigned;
              removedMembers += r.removed;
            }

            // sub-items → card checklist
            if (this.settings.syncSubtasks && (item.children.length || this.settings.allowDeletes)) {
              const r = await this.syncSubtasksForCard(existing, item.children);
              subAdded += r.added;
              subCompleted += r.completed;
              removedSubs += r.removed || 0;
              subRenamed += r.renamed || 0;
              subReordered += r.reordered || 0;
            }

            // item checked in note → move card to done list
            if (item.done && this.settings.moveDoneCards && firstDoneList && !doneNames.includes(cardListName[existing.publicId])) {
              await this.client.updateCard(existing.publicId, { listPublicId: firstDoneList.publicId });
              moved++;
            }
            continue;
          }

          if (item.done) continue;

          const labelIds = this.settings.syncTags ? item.tags.map((t) => labelMap[t.toLowerCase()]).filter(Boolean) : [];
          const memberIds = this.settings.syncMembers ? this.resolveMentionIds(item.mentions, wsMembers) : [];
          const desc = this.settings.syncDescription
            ? buildCardDescription(file.path, item.description)
            : buildCardDescription(file.path, "");
          const nc = await this.client.createCard(
            listId, item.title, desc, toIsoDue(item.due), labelIds, memberIds,
            this.settings.newCardPosition || "end"
          );
          created++;
          if (nc && nc.publicId) noteCardIds.add(nc.publicId);
          if (this.settings.useIdMarkers && nc && nc.publicId) markers.push({ lineNo: item.lineNo, id: nc.publicId });
          if (memberIds.length) assigned += memberIds.length;

          if (this.settings.syncSubtasks && item.children.length && nc && nc.publicId) {
            const r = await this.syncSubtasksForCard({ publicId: nc.publicId, checklists: [] }, item.children);
            subAdded += r.added;
            subCompleted += r.completed;
            subRenamed += r.renamed || 0;
            subReordered += r.reordered || 0;
          }
        }
      }

      // Optional: delete cards that originated from this note but are no longer in it
      if (this.settings.allowDeletes) {
        const pathNeedle = DESC_PREFIX + file.path;
        for (const l of board.lists || []) {
          for (const c of l.cards || []) {
            if (noteCardIds.has(c.publicId)) continue;
            const d = c.description || "";
            if (d === pathNeedle || d.startsWith(pathNeedle + "\n")) {
              await this.client.deleteCard(c.publicId);
              deleted++;
            }
          }
        }
      }

      if (markers.length) {
        // re-read in case frontmatter write shifted lines — markers use pre-frontmatter line numbers from parse
        // Prefer editing by appending markers on original parse lines when content unchanged enough
        const fresh = await this.app.vault.read(file);
        const freshLines = fresh.split("\n");
        // Map by kan intent: apply markers using title+approximate line from original parse against current file
        for (const m of markers) {
          if (m.lineNo < freshLines.length && !MARKER_RE.test(freshLines[m.lineNo])
            && normTitle(freshLines[m.lineNo]) === normTitle(lines[m.lineNo] || "")) {
            freshLines[m.lineNo] += ` %%kan:${m.id}%%`;
          } else {
            // fallback: find unmarked line with same title
            for (let i = 0; i < freshLines.length; i++) {
              if (MARKER_RE.test(freshLines[i])) continue;
              if (/^-\s*\[[ xX]\]/.test(freshLines[i]) && normTitle(freshLines[i]) === normTitle(lines[m.lineNo] || "")) {
                freshLines[i] += ` %%kan:${m.id}%%`;
                break;
              }
            }
          }
        }
        await this.app.vault.modify(file, freshLines.join("\n"));
      }

      const bits = [`${created} created`, `${updated} updated`];
      if (adopted) bits.push(`${adopted} linked`);
      if (moved) bits.push(`${moved} moved to done`);
      if (subAdded) bits.push(`${subAdded} subtasks`);
      if (subCompleted) bits.push(`${subCompleted} subtasks completed`);
      if (labeled) bits.push(`${labeled} labels`);
      if (assigned) bits.push(`${assigned} assigned`);
      if (descUpdated) bits.push(`${descUpdated} descriptions`);
      if (clearedDue) bits.push(`${clearedDue} due cleared`);
      if (deleted) bits.push(`${deleted} deleted`);
      if (removedLabels) bits.push(`${removedLabels} labels removed`);
      if (removedMembers) bits.push(`${removedMembers} members removed`);
      if (removedSubs) bits.push(`${removedSubs} subtasks removed`);
      if (subRenamed) bits.push(`${subRenamed} subtasks renamed`);
      if (subReordered) bits.push(`${subReordered} subtasks reordered`);
      new Notice(`Kan "${boardName}": ${bits.join(", ")}.`);
    } catch (e) {
      new Notice("Kan error: " + e.message, 8000);
      console.error(e);
    }
  }

  async pullStatus(opts) {
    const silent = opts && opts.silent;
    const file = this.app.workspace.getActiveFile();
    if (!file) { if (!silent) new Notice("No active note."); return; }
    if (!this.settings.workspaceId) { if (!silent) new Notice("Set workspace in Settings → Kan Sync."); return; }

    const boardName = this.boardNameForFile(file);
    try {
      let board = null;
      const id = this.boardIdForFile(file);
      if (id) {
        try { board = await this.client.getBoard(id); }
        catch (e) { console.warn("Kan: kan_board_id missing on pull, falling back", e); }
      }
      if (!board) {
        const slug = this.boardSlugForFile(file);
        const wsSlug = this.workspaceSlugForFile(file);
        if (slug && wsSlug) {
          try { board = await this.client.getBoardBySlug(wsSlug, slug); }
          catch (e) { console.warn("Kan: slug lookup failed on pull", e); }
        }
      }
      if (!board) {
        const byName = await this.findBoardByName(boardName);
        if (!byName) { if (!silent) new Notice(`No Kan board named "${boardName}".`); return; }
        board = await this.client.getBoard(byName.publicId);
      }
      await this.ensureBoardIdFrontmatter(file, board.publicId, board.slug);

      const doneNames = this.settings.doneLists.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const doneTitles = new Set();
      const doneIds = new Set();
      const cardsById = {};
      const rows = [];
      for (const l of board.lists || []) {
        const cards = l.cards || [];
        const titles = this.settings.includeTitlesInStatus ? cards.map((c) => c.title).join("; ").slice(0, 300) : "—";
        rows.push(`| ${l.name} | ${cards.length} | ${titles} |`);
        for (const c of cards) cardsById[c.publicId] = c;
        if (doneNames.includes(l.name.toLowerCase()))
          for (const c of cards) { doneTitles.add(normTitle(c.title)); doneIds.add(c.publicId); }
      }

      let content = await this.app.vault.read(file);
      let checked = 0;
      let enriched = 0;
      let currentCardId = null;

      const enrich = this.settings.pullDueDates || this.settings.pullTags || this.settings.pullMentions;

      content = content.split("\n").map((line) => {
        const top = line.match(/^(\s*)-\s*\[( |x|X)\]\s+(.*)/);
        if (top && top[1].length === 0) {
          currentCardId = (top[3].match(MARKER_RE) || [])[1] || null;
          let out = line;
          if (top[2] === " ") {
            const isDone = currentCardId ? doneIds.has(currentCardId) : doneTitles.has(normTitle(top[3]));
            if (isDone) { checked++; out = out.replace("[ ]", "[x]"); }
          }
          if (enrich && currentCardId && cardsById[currentCardId]) {
            const next = enrichChecklistLine(out, cardsById[currentCardId], this.settings);
            if (next !== out) { enriched++; out = next; }
          }
          return out;
        }
        // indented sub-item: check off if its checklist item is completed in Kan
        const sub = line.match(/^(\s+-\s*)\[ \](\s+)(.*)/);
        if (sub && currentCardId && cardsById[currentCardId]) {
          const card = cardsById[currentCardId];
          for (const cl of card.checklists || [])
            for (const it of cl.items || [])
              if (it.completed && normTitle(it.title) === normTitle(sub[3])) { checked++; return `${sub[1]}[x]${sub[2]}${sub[3]}`; }
        }
        return line;
      }).join("\n");

      const heading = this.settings.statusHeading || DEFAULT_SETTINGS.statusHeading;
      const now = new Date().toISOString().slice(0, 16).replace("T", " ");
      const section = [
        heading, "",
        `> Synced from Kan board **${board.name}** at ${now}`, "",
        "| List | Cards | Titles |", "|------|-------|--------|",
        ...rows, "",
      ].join("\n");

      const start = content.indexOf(heading);
      if (start !== -1) {
        const nextH2 = content.indexOf("\n## ", start + heading.length);
        const end = nextH2 === -1 ? content.length : nextH2 + 1;
        content = content.slice(0, start) + section + content.slice(end);
      } else {
        content = content.trimEnd() + "\n\n" + section;
      }

      await this.app.vault.modify(file, content);
      if (!silent) {
        const bits = [`${checked} item(s) checked off`];
        if (enriched) bits.push(`${enriched} enriched`);
        new Notice(`Kan: status pulled. ${bits.join(", ")}.`);
      }
    } catch (e) {
      if (!silent) new Notice("Kan error: " + e.message, 8000);
      console.error(e);
    }
  }
}

/* ---------------- settings tab ---------------- */

class KanSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Connection" });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Create one at kan.bn/settings. Stored locally in this vault's plugin data.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("kan_…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => { this.plugin.settings.apiKey = v.trim(); await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Kan API base. Change only for self-hosted instances.")
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.baseUrl)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => { this.plugin.settings.baseUrl = v.trim() || DEFAULT_SETTINGS.baseUrl; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Workspace")
      .setDesc("Click Detect to load your workspaces, then pick one. Stores ID and slug when available.")
      .addText((t) =>
        t.setPlaceholder("workspace publicId")
          .setValue(this.plugin.settings.workspaceId)
          .onChange(async (v) => { this.plugin.settings.workspaceId = v.trim(); await this.plugin.saveSettings(); })
      )
      .addButton((b) =>
        b.setButtonText("Detect").onClick(async () => {
          try {
            const wss = await this.plugin.client.getWorkspaces();
            if (!wss.length) { new Notice("No workspaces found."); return; }
            if (!wss[0].publicId) { new Notice("Unexpected workspace response — see console."); console.log("Kan raw:", wss); return; }
            this.plugin.settings.workspaceId = wss[0].publicId;
            if (wss[0].slug) this.plugin.settings.workspaceSlug = wss[0].slug;
            await this.plugin.saveSettings();
            new Notice(`Workspace set: ${wss[0].name || wss[0].publicId}${wss.length > 1 ? ` (+${wss.length - 1} more — see console)` : ""}`);
            console.log("Kan workspaces:", wss);
            this.display();
          } catch (e) { new Notice("Kan error: " + e.message, 8000); }
        })
      );

    new Setting(containerEl)
      .setName("Workspace slug")
      .setDesc("Optional. Used with kan_board_slug frontmatter for slug-based board lookup.")
      .addText((t) =>
        t.setPlaceholder("my-workspace")
          .setValue(this.plugin.settings.workspaceSlug || "")
          .onChange(async (v) => { this.plugin.settings.workspaceSlug = v.trim(); await this.plugin.saveSettings(); })
      );

    containerEl.createEl("h2", { text: "Push (note → Kan)" });

    new Setting(containerEl)
      .setName("Rename-safe ID markers")
      .setDesc("Append hidden %%kan:ID%% comments to synced items so renames update cards instead of duplicating them.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useIdMarkers)
          .onChange(async (v) => { this.plugin.settings.useIdMarkers = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Sync #tags as labels")
      .setDesc("Tags on checklist items become Kan labels (created automatically with a colour).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncTags)
          .onChange(async (v) => { this.plugin.settings.syncTags = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Retro-label existing cards")
      .setDesc("When you add a #tag to an already-synced item, add the label to its card on next push.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.retroLabel)
          .onChange(async (v) => { this.plugin.settings.retroLabel = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Sync @mentions as card members")
      .setDesc("@name on an item assigns the matching workspace member (by name or email prefix) to its card.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncMembers)
          .onChange(async (v) => { this.plugin.settings.syncMembers = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Sync card descriptions")
      .setDesc("Indented text under a checklist item (not a sub-checkbox) becomes the card description. Always includes a source path header.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncDescription)
          .onChange(async (v) => { this.plugin.settings.syncDescription = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Rename board to match note")
      .setDesc("On push, rename the linked Kan board when the note name / kan_board frontmatter changes. Stores kan_board_id in frontmatter.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.renameBoard)
          .onChange(async (v) => { this.plugin.settings.renameBoard = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Rename lists to match headings")
      .setDesc("On push, rename a Kan list when its heading changes (cards with markers already live in that list).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.renameLists)
          .onChange(async (v) => { this.plugin.settings.renameLists = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Reorder lists to match heading order")
      .setDesc("On push, set list index to match ## heading order in the note.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reorderLists !== false)
          .onChange(async (v) => { this.plugin.settings.reorderLists = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("New card position")
      .setDesc("Where newly created cards are inserted in a list.")
      .addDropdown((d) =>
        d.addOption("end", "End of list")
          .addOption("start", "Start of list")
          .setValue(this.plugin.settings.newCardPosition || "end")
          .onChange(async (v) => { this.plugin.settings.newCardPosition = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Allow deletes on push")
      .setDesc("Off by default. When on: removing a tag/mention/sub-item or a whole synced item from the note removes the matching label/member/checklist item/card in Kan. Also enables the Delete linked card command.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowDeletes)
          .onChange(async (v) => { this.plugin.settings.allowDeletes = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Sync sub-items as card checklists")
      .setDesc("Indented checkboxes under an item become a checklist on its card.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncSubtasks)
          .onChange(async (v) => { this.plugin.settings.syncSubtasks = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Subtask checklist name")
      .setDesc("Name of the card checklist that receives sub-items.")
      .addText((t) =>
        t.setValue(this.plugin.settings.subtaskChecklistName)
          .onChange(async (v) => { this.plugin.settings.subtaskChecklistName = v || "Subtasks"; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Move done cards")
      .setDesc("When an item is checked in the note, move its card to the first 'Done' list on next push.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.moveDoneCards)
          .onChange(async (v) => { this.plugin.settings.moveDoneCards = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Default list name")
      .setDesc("List used for checklist items that appear before any heading.")
      .addText((t) =>
        t.setValue(this.plugin.settings.defaultListName)
          .onChange(async (v) => { this.plugin.settings.defaultListName = v || "Backlog"; await this.plugin.saveSettings(); })
      );

    containerEl.createEl("h2", { text: "Pull (Kan → note)" });

    new Setting(containerEl)
      .setName("Pull due dates")
      .setDesc("Write 📅 YYYY-MM-DD onto checklist lines from the card due date.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pullDueDates)
          .onChange(async (v) => { this.plugin.settings.pullDueDates = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Pull labels as #tags")
      .setDesc("Write card labels onto checklist lines as #tags.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pullTags)
          .onChange(async (v) => { this.plugin.settings.pullTags = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Pull members as @mentions")
      .setDesc("Write card members onto checklist lines as @handles.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pullMentions)
          .onChange(async (v) => { this.plugin.settings.pullMentions = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Done lists")
      .setDesc("Comma-separated list names treated as 'completed' when pulling status.")
      .addText((t) =>
        t.setValue(this.plugin.settings.doneLists)
          .onChange(async (v) => { this.plugin.settings.doneLists = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Status section heading")
      .setDesc("Heading used for the status section written into notes.")
      .addText((t) =>
        t.setValue(this.plugin.settings.statusHeading)
          .onChange(async (v) => { this.plugin.settings.statusHeading = v || DEFAULT_SETTINGS.statusHeading; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Include card titles in status")
      .setDesc("Off = counts only, for compact status tables.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeTitlesInStatus)
          .onChange(async (v) => { this.plugin.settings.includeTitlesInStatus = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("0 = off. Auto-pulls status for the active note if it has a kan_board frontmatter key.")
      .addText((t) =>
        t.setPlaceholder("0")
          .setValue(String(this.plugin.settings.autoSyncMinutes))
          .onChange(async (v) => { this.plugin.settings.autoSyncMinutes = Math.max(0, parseInt(v) || 0); await this.plugin.saveSettings(); })
      );

    this.renderAdmin(containerEl);
  }

  renderAdmin(containerEl) {
    const p = this.plugin;
    const ws = () => p.settings.workspaceId;

    containerEl.createEl("h2", { text: "Account" });
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Calls /health and /users/me.")
      .addButton((b) => b.setButtonText("Test").onClick(() => p.testConnection()));
    new Setting(containerEl)
      .setName("Instance stats")
      .setDesc("GET /stats — logs to console.")
      .addButton((b) => b.setButtonText("Fetch").onClick(async () => {
        try {
          const s = await p.client.stats();
          console.log("Kan stats:", s);
          new Notice("Stats logged to console.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      }));
    new Setting(containerEl)
      .setName("Update display name")
      .addButton((b) => b.setButtonText("Edit").onClick(() => {
        new KanPromptModal(this.app, "Update user", [
          { key: "name", label: "Name", value: "" },
        ], async (v) => {
          await p.client.updateUser({ name: v.name });
          new Notice("Profile updated.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Set password")
      .setDesc("For accounts created via magic link.")
      .addButton((b) => b.setButtonText("Set").setWarning().onClick(() => {
        new KanPromptModal(this.app, "Set password", [
          { key: "newPassword", label: "New password", type: "password", value: "" },
        ], async (v) => {
          await p.client.setPassword(v.newPassword);
          new Notice("Password set.");
        }).open();
      }));

    containerEl.createEl("h2", { text: "Workspace admin" });
    new Setting(containerEl)
      .setName("Get workspace")
      .setDesc("Fetch by ID or slug; result logged to console.")
      .addButton((b) => b.setButtonText("By ID").onClick(async () => {
        try {
          console.log("workspace", await p.client.getWorkspace(ws()));
          new Notice("Workspace logged to console.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      }))
      .addButton((b) => b.setButtonText("By slug").onClick(() => {
        new KanPromptModal(this.app, "Get workspace by slug", [
          { key: "slug", label: "Workspace slug", value: p.settings.workspaceSlug || "" },
        ], async (v) => {
          const w = await p.client.getWorkspaceBySlug(v.slug.trim());
          console.log("workspace by slug", w);
          if (w && w.publicId) {
            p.settings.workspaceId = w.publicId;
            if (w.slug) p.settings.workspaceSlug = w.slug;
            await p.saveSettings();
          }
          new Notice("Workspace logged (and settings updated if found).");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Lookup invite code")
      .addButton((b) => b.setButtonText("Lookup").onClick(() => {
        new KanPromptModal(this.app, "Lookup invite", [
          { key: "code", label: "Invite code", value: "" },
        ], async (v) => {
          console.log("invite", await p.client.getInviteInfo(v.code.trim()));
          new Notice("Invite info logged to console.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Create workspace")
      .addButton((b) => b.setButtonText("Create").onClick(() => {
        new KanPromptModal(this.app, "Create workspace", [
          { key: "name", label: "Name", value: "" },
          { key: "slug", label: "Slug", value: "" },
          { key: "description", label: "Description", type: "textarea", value: "" },
        ], async (v) => {
          if (v.slug) {
            try { await p.client.checkWorkspaceSlug(v.slug); } catch (e) { /* continue */ }
          }
          const created = await p.client.createWorkspace({ name: v.name, slug: v.slug || undefined, description: v.description || undefined });
          if (created && created.publicId) {
            p.settings.workspaceId = created.publicId;
            await p.saveSettings();
          }
          new Notice("Workspace created.");
          this.display();
        }).open();
      }));
    new Setting(containerEl)
      .setName("Update current workspace")
      .addButton((b) => b.setButtonText("Edit").onClick(() => {
        new KanPromptModal(this.app, "Update workspace", [
          { key: "name", label: "Name", value: "" },
          { key: "slug", label: "Slug", value: "" },
          { key: "description", label: "Description", type: "textarea", value: "" },
          { key: "weekStartDay", label: "Week start day (0-6)", value: "1" },
        ], async (v) => {
          const patch = {};
          if (v.name) patch.name = v.name;
          if (v.slug) patch.slug = v.slug;
          if (v.description) patch.description = v.description;
          if (v.weekStartDay !== "") patch.weekStartDay = parseInt(v.weekStartDay, 10);
          await p.client.updateWorkspace(ws(), patch);
          new Notice("Workspace updated.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Invite member")
      .addButton((b) => b.setButtonText("Invite").onClick(() => {
        new KanPromptModal(this.app, "Invite member", [
          { key: "email", label: "Email", value: "" },
        ], async (v) => {
          await p.client.inviteMember(ws(), v.email.trim());
          new Notice("Invite sent.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Invite link")
      .setDesc("Create, copy, or deactivate the workspace invite link.")
      .addButton((b) => b.setButtonText("Copy").onClick(async () => {
        try {
          let link = await p.client.getInviteLink(ws());
          if (!link || !(link.url || link.code)) link = await p.client.createInviteLink(ws());
          await navigator.clipboard.writeText(String(link.url || link.code || JSON.stringify(link)));
          new Notice("Copied.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      }))
      .addButton((b) => b.setButtonText("Deactivate").setWarning().onClick(() => {
        new KanConfirmModal(this.app, "Deactivate invite", "Deactivate the active invite link?", async () => {
          await p.client.deactivateInviteLink(ws());
          new Notice("Invite link deactivated.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Accept invite code")
      .addButton((b) => b.setButtonText("Accept").onClick(() => {
        new KanPromptModal(this.app, "Accept invite", [
          { key: "inviteCode", label: "Invite code", value: "" },
        ], async (v) => {
          await p.client.acceptInvite(v.inviteCode.trim());
          new Notice("Invite accepted.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Manage member")
      .setDesc("Update role or remove a member by public ID.")
      .addButton((b) => b.setButtonText("Role").onClick(() => {
        new KanPromptModal(this.app, "Update member role", [
          { key: "memberId", label: "Member public ID", value: "" },
          { key: "role", label: "Role", value: "member", type: "select", options: [
            { value: "admin", label: "admin" }, { value: "member", label: "member" }, { value: "guest", label: "guest" },
          ]},
        ], async (v) => {
          await p.client.updateMemberRole(ws(), v.memberId.trim(), v.role);
          new Notice("Role updated.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("Remove").setWarning().onClick(() => {
        new KanPromptModal(this.app, "Remove member", [
          { key: "memberId", label: "Member public ID", value: "" },
        ], async (v) => {
          new KanConfirmModal(this.app, "Remove member", "Remove this member from the workspace?", async () => {
            await p.client.removeMember(ws(), v.memberId.trim());
            new Notice("Member removed.");
          }).open();
        }).open();
      }));
    new Setting(containerEl)
      .setName("My permissions")
      .addButton((b) => b.setButtonText("Show").onClick(async () => {
        try {
          const perms = await p.client.getMyPermissions(ws());
          console.log("Kan permissions:", perms);
          new Notice("Permissions logged to console.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      }));

    containerEl.createEl("h2", { text: "Roles & permissions" });
    new Setting(containerEl)
      .setName("List roles")
      .addButton((b) => b.setButtonText("Log roles").onClick(async () => {
        try {
          console.log("roles", await p.client.getRoles(ws()));
          console.log("role permissions", await p.client.getWorkspaceRolePermissions(ws()));
          new Notice("Roles logged to console.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); }
      }));
    new Setting(containerEl)
      .setName("Inspect permissions")
      .setDesc("Fetch permissions for a specific role or member.")
      .addButton((b) => b.setButtonText("Role").onClick(() => {
        new KanPromptModal(this.app, "Role permissions", [
          { key: "roleId", label: "Role public ID", value: "" },
        ], async (v) => {
          console.log("role permissions", await p.client.getRolePermissions(ws(), v.roleId.trim()));
          new Notice("Role permissions logged.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("Member").onClick(() => {
        new KanPromptModal(this.app, "Member permissions", [
          { key: "memberId", label: "Member public ID", value: "" },
        ], async (v) => {
          console.log("member permissions", await p.client.getMemberPermissions(ws(), v.memberId.trim()));
          new Notice("Member permissions logged.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Grant / revoke role permission")
      .addButton((b) => b.setButtonText("Grant").onClick(() => {
        new KanPromptModal(this.app, "Grant role permission", [
          { key: "roleId", label: "Role public ID", value: "" },
          { key: "permission", label: "Permission", value: "" },
        ], async (v) => {
          await p.client.grantRolePermission(ws(), v.roleId.trim(), v.permission.trim());
          new Notice("Granted.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("Revoke").onClick(() => {
        new KanPromptModal(this.app, "Revoke role permission", [
          { key: "roleId", label: "Role public ID", value: "" },
          { key: "permission", label: "Permission", value: "" },
        ], async (v) => {
          await p.client.revokeRolePermission(ws(), v.roleId.trim(), v.permission.trim());
          new Notice("Revoked.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Member permission overrides")
      .addButton((b) => b.setButtonText("Grant").onClick(() => {
        new KanPromptModal(this.app, "Grant member permission", [
          { key: "memberId", label: "Member public ID", value: "" },
          { key: "permission", label: "Permission", value: "" },
        ], async (v) => {
          await p.client.grantMemberPermission(ws(), v.memberId.trim(), v.permission.trim());
          new Notice("Granted.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("Revoke").onClick(() => {
        new KanPromptModal(this.app, "Revoke member permission", [
          { key: "memberId", label: "Member public ID", value: "" },
          { key: "permission", label: "Permission", value: "" },
        ], async (v) => {
          await p.client.revokeMemberPermission(ws(), v.memberId.trim(), v.permission.trim());
          new Notice("Revoked.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Reset permission overrides")
      .addButton((b) => b.setButtonText("One member").onClick(() => {
        new KanPromptModal(this.app, "Reset member permissions", [
          { key: "memberId", label: "Member public ID", value: "" },
        ], async (v) => {
          await p.client.resetMemberPermissions(ws(), v.memberId.trim());
          new Notice("Reset.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("All members").setWarning().onClick(() => {
        new KanConfirmModal(this.app, "Reset all overrides", "Clear all member permission overrides in this workspace?", async () => {
          await p.client.resetAllMemberPermissions(ws());
          new Notice("All overrides reset.");
        }).open();
      }));

    containerEl.createEl("h2", { text: "Webhooks" });
    containerEl.createDiv({
      cls: "setting-item-description",
      text: "Manage Kan webhooks here. Obsidian cannot receive inbound webhook HTTP — use an external relay if you need live event→vault sync.",
    });
    new Setting(containerEl)
      .setName("List webhooks")
      .addButton((b) => b.setButtonText("Log").onClick(async () => {
        try { console.log(await p.client.getWebhooks(ws())); new Notice("Webhooks logged."); }
        catch (e) { new Notice("Kan error: " + e.message, 8000); }
      }));
    new Setting(containerEl)
      .setName("Create webhook")
      .addButton((b) => b.setButtonText("Create").onClick(() => {
        new KanPromptModal(this.app, "Create webhook", [
          { key: "name", label: "Name", value: "Obsidian relay" },
          { key: "url", label: "URL", value: "https://" },
          { key: "secret", label: "Secret (optional)", value: "" },
          { key: "events", label: "Events (comma-separated)", value: WEBHOOK_EVENTS.join(",") },
        ], async (v) => {
          const events = v.events.split(",").map((s) => s.trim()).filter(Boolean);
          await p.client.createWebhook(ws(), { name: v.name, url: v.url, secret: v.secret || undefined, events });
          new Notice("Webhook created.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Update / test / delete webhook")
      .addButton((b) => b.setButtonText("Update").onClick(() => {
        new KanPromptModal(this.app, "Update webhook", [
          { key: "id", label: "Webhook public ID", value: "" },
          { key: "name", label: "Name", value: "" },
          { key: "url", label: "URL", value: "" },
          { key: "active", label: "Active", type: "toggle", value: true },
          { key: "events", label: "Events (comma-separated)", value: WEBHOOK_EVENTS.join(",") },
        ], async (v) => {
          await p.client.updateWebhook(ws(), v.id.trim(), {
            name: v.name || undefined,
            url: v.url || undefined,
            active: v.active,
            events: v.events.split(",").map((s) => s.trim()).filter(Boolean),
          });
          new Notice("Webhook updated.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("Test").onClick(() => {
        new KanPromptModal(this.app, "Test webhook", [
          { key: "id", label: "Webhook public ID", value: "" },
        ], async (v) => {
          await p.client.testWebhook(ws(), v.id.trim());
          new Notice("Test sent.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("Delete").setWarning().onClick(() => {
        new KanPromptModal(this.app, "Delete webhook", [
          { key: "id", label: "Webhook public ID", value: "" },
        ], async (v) => {
          new KanConfirmModal(this.app, "Delete webhook", "Delete this webhook?", async () => {
            await p.client.deleteWebhook(ws(), v.id.trim());
            new Notice("Deleted.");
          }).open();
        }).open();
      }));

    containerEl.createEl("h2", { text: "Integrations & imports" });
    new Setting(containerEl)
      .setName("Integration providers")
      .addButton((b) => b.setButtonText("List").onClick(async () => {
        try { console.log(await p.client.getIntegrationProviders()); new Notice("Providers logged."); }
        catch (e) { new Notice("Kan error: " + e.message, 8000); }
      }));
    new Setting(containerEl)
      .setName("Connect integration")
      .addButton((b) => b.setButtonText("Authorize").onClick(() => {
        new KanPromptModal(this.app, "Authorize integration", [
          { key: "provider", label: "Provider", value: "trello", type: "select", options: [
            { value: "trello", label: "trello" }, { value: "github", label: "github" },
          ]},
        ], async (v) => {
          const res = await p.client.getIntegrationAuthorizeUrl(v.provider);
          const url = res.url || res.authorizationUrl || res;
          if (typeof url === "string") window.open(url);
          else { console.log(res); new Notice("Authorize URL logged to console."); }
        }).open();
      }))
      .addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(() => {
        new KanPromptModal(this.app, "Disconnect integration", [
          { key: "provider", label: "Provider", value: "trello" },
        ], async (v) => {
          await p.client.disconnectIntegration(v.provider.trim());
          new Notice("Disconnected.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Import from Trello")
      .addButton((b) => b.setButtonText("Import").onClick(() => new KanImportModal(this.app, p, "trello").open()));
    new Setting(containerEl)
      .setName("Import from GitHub")
      .addButton((b) => b.setButtonText("Import").onClick(() => new KanImportModal(this.app, p, "github").open()));

    containerEl.createEl("h2", { text: "Labels (board)" });
    new Setting(containerEl)
      .setName("Get label by ID")
      .addButton((b) => b.setButtonText("Fetch").onClick(() => {
        new KanPromptModal(this.app, "Get label", [
          { key: "id", label: "Label public ID", value: "" },
        ], async (v) => {
          console.log("label", await p.client.getLabel(v.id.trim()));
          new Notice("Label logged to console.");
        }).open();
      }));
    new Setting(containerEl)
      .setName("Update / delete label by ID")
      .addButton((b) => b.setButtonText("Update").onClick(() => {
        new KanPromptModal(this.app, "Update label", [
          { key: "id", label: "Label public ID", value: "" },
          { key: "name", label: "Name", value: "" },
          { key: "colourCode", label: "Colour (#hex)", value: "#3498db" },
        ], async (v) => {
          await p.client.updateLabel(v.id.trim(), { name: v.name, colourCode: v.colourCode });
          new Notice("Label updated.");
        }).open();
      }))
      .addButton((b) => b.setButtonText("Delete").setWarning().onClick(() => {
        new KanPromptModal(this.app, "Delete label", [
          { key: "id", label: "Label public ID", value: "" },
        ], async (v) => {
          new KanConfirmModal(this.app, "Delete label", "Delete this label from the board?", async () => {
            await p.client.deleteLabel(v.id.trim());
            new Notice("Label deleted.");
          }).open();
        }).open();
      }));

    containerEl.createEl("h2", { text: "Danger zone" });
    new Setting(containerEl)
      .setName("Delete current workspace")
      .setDesc("Irreversible. Requires typing the workspace ID.")
      .addButton((b) => b.setButtonText("Delete workspace").setWarning().onClick(() => {
        new KanPromptModal(this.app, "Delete workspace", [
          { key: "confirmId", label: `Type workspace ID to confirm (${ws()})`, value: "" },
        ], async (v) => {
          if (v.confirmId.trim() !== ws()) { new Notice("ID did not match."); return; }
          new KanConfirmModal(this.app, "Final confirm", "Really delete this workspace?", async () => {
            await p.client.deleteWorkspace(ws());
            p.settings.workspaceId = "";
            await p.saveSettings();
            new Notice("Workspace deleted.");
            this.display();
          }).open();
        }).open();
      }));
  }
}

module.exports = KanSyncPlugin;
