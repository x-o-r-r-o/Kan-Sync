/* Kan Sync v0.6.0 — plugin for Kan.bn
 * https://github.com/x-o-r-r-o/
 *
 * v0.6.0: description sync, richer pull (due/#tags/@mentions), clear due date,
 * optional deletes, board/list rename, members on create, duplicate card.
 * v0.5.2: README disclosures; release with artifact attestations.
 * v0.5.1: Fix community manifest description (remove banned word).
 * v0.5.0: @person member sync, card detail modal, multi-workspace switcher.
 */

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, requestUrl, Modal, SuggestModal } = require("obsidian");

const VIEW_TYPE_KAN = "kan-board-view";
const MARKER_RE = /\s*%%kan:([\w-]+)%%/;
const DUE_RE = /(?:📅|@due\()\s*(\d{4}-\d{2}-\d{2})\)?/u;
const TAG_RE = /(^|\s)#([\w/-]+)/g;
const MENTION_RE = /(^|\s)@([\w.-]+)/g;
const LABEL_COLOURS = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#34495e"];
const DESC_PREFIX = "From Obsidian: ";

const DEFAULT_SETTINGS = {
  apiKey: "",
  workspaceId: "",
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
};

/* ---------------- API client ---------------- */

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

  async getWorkspaces() {
    const raw = await this.req("GET", "/workspaces");
    return (raw || []).map((w) => (w && w.workspace) ? w.workspace : w).filter(Boolean);
  }
  getBoards(wsId) { return this.req("GET", `/workspaces/${wsId}/boards`); }
  getBoard(boardId) { return this.req("GET", `/boards/${boardId}`); }
  createBoard(wsId, name, listNames) {
    return this.req("POST", `/workspaces/${wsId}/boards`, { name, lists: listNames, labels: [] });
  }
  createList(boardId, name) { return this.req("POST", "/lists", { name, boardPublicId: boardId }); }
  updateList(listId, patch) { return this.req("PUT", `/lists/${listId}`, patch); }
  updateBoard(boardId, patch) { return this.req("PUT", `/boards/${boardId}`, patch); }
  createCard(listId, title, description, dueDate, labelPublicIds, memberPublicIds) {
    return this.req("POST", "/cards", {
      title: title.slice(0, 2000),
      description: (description || "").slice(0, 10000),
      listPublicId: listId,
      labelPublicIds: labelPublicIds || [],
      memberPublicIds: memberPublicIds || [],
      position: "end",
      dueDate: dueDate || null,
    });
  }
  updateCard(cardId, patch) { return this.req("PUT", `/cards/${cardId}`, patch); }
  deleteCard(cardId) { return this.req("DELETE", `/cards/${cardId}`); }
  duplicateCard(cardId, listPublicId, opts) {
    opts = opts || {};
    return this.req("POST", `/cards/${cardId}/duplicate`, {
      listPublicId,
      copyLabels: opts.copyLabels !== false,
      copyMembers: opts.copyMembers !== false,
      copyChecklists: opts.copyChecklists !== false,
      title: opts.title,
    });
  }
  createLabel(boardId, name, colourCode) {
    return this.req("POST", "/labels", { name: name.slice(0, 36), boardPublicId: boardId, colourCode });
  }
  toggleCardLabel(cardId, labelId) { return this.req("PUT", `/cards/${cardId}/labels/${labelId}`); }
  addComment(cardId, comment) { return this.req("POST", `/cards/${cardId}/comments`, { comment }); }
  createChecklist(cardId, name) { return this.req("POST", `/cards/${cardId}/checklists`, { name: name.slice(0, 255) }); }
  addChecklistItem(checklistId, title) { return this.req("POST", `/checklists/${checklistId}/items`, { title: title.slice(0, 500) }); }
  deleteChecklistItem(itemId) { return this.req("DELETE", `/checklists/items/${itemId}`); }
  search(wsId, query, limit) {
    return this.req("GET", `/workspaces/${wsId}/search?query=${encodeURIComponent(query.slice(0, 100))}&limit=${limit || 20}`);
  }
  updateChecklistItem(itemId, patch) { return this.req("PATCH", `/checklists/items/${itemId}`, patch); }
  getCard(cardId) { return this.req("GET", `/cards/${cardId}`); }
  toggleCardMember(cardId, memberId) { return this.req("PUT", `/cards/${cardId}/members/${memberId}`); }
  getCardActivities(cardId, limit) { return this.req("GET", `/cards/${cardId}/activities?limit=${limit || 20}`); }
  getAttachmentUploadUrl(cardId, filename, contentType, size) {
    return this.req("POST", `/cards/${cardId}/attachments/upload-url`, { filename: filename.slice(0, 255), contentType, size });
  }
  confirmAttachment(cardId, s3Key, filename, contentType, size) {
    return this.req("POST", `/cards/${cardId}/attachments/confirm`, {
      s3Key, filename: filename.slice(0, 255), originalFilename: filename.slice(0, 255), contentType, size,
    });
  }
  deleteAttachment(attachmentId) { return this.req("DELETE", `/attachments/${attachmentId}`); }
  // presigned S3 PUT — must NOT carry the Kan Authorization header
  async uploadToPresigned(url, data, contentType) {
    const res = await requestUrl({ url, method: "PUT", headers: { "Content-Type": contentType }, body: data, throw: false });
    if (res.status >= 400) throw new Error(`S3 upload failed (${res.status})`);
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

// Parse note → sections with items, nested sub-items, and description lines.
function parseNote(content, defaultListName) {
  const lines = content.split("\n");
  const sections = [];
  let current = { name: defaultListName || "Backlog", items: [] };
  let inCode = false;
  let lastTopItem = null;

  lines.forEach((line, lineNo) => {
    if (/^```/.test(line.trim())) { inCode = !inCode; return; }
    if (inCode) return;

    const h = line.match(/^#{2,4}\s+(.*)/);
    if (h) {
      if (current.items.length) sections.push(current);
      current = { name: cleanText(h[1]), items: [] };
      lastTopItem = null;
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
        lastTopItem = { done: m[2] !== " ", title, kanId, due, tags, mentions, lineNo, children: [], description: "" };
        current.items.push(lastTopItem);
      } else if (lastTopItem) {
        lastTopItem.children.push({ done: m[2] !== " ", title, lineNo });
      }
      return;
    }

    // Indented non-checkbox text under a top-level item → card description
    if (lastTopItem && /^\s+\S/.test(line) && !/^\s*-\s*\[/.test(line)) {
      const text = line.replace(/^\s+/, "");
      lastTopItem.description = lastTopItem.description
        ? lastTopItem.description + "\n" + text
        : text;
    }
  });
  if (current.items.length) sections.push(current);
  return { sections, lines };
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
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("kan-card-modal");
    contentEl.setText("Loading card…");
    let card;
    try { card = await this.plugin.client.getCard(this.cardId); }
    catch (e) { contentEl.setText("Error: " + e.message); return; }
    contentEl.empty();

    // header
    const prefix = card.list?.board?.workspace?.cardPrefix;
    contentEl.createEl("h3", { text: (prefix && card.cardNumber ? `${prefix}-${card.cardNumber} · ` : "") + card.title });
    const meta = contentEl.createDiv({ cls: "kan-modal-meta" });
    meta.createSpan({ text: `📁 ${card.list?.board?.name || ""} → ${card.list?.name || ""}` });
    if (card.dueDate) meta.createSpan({ text: `  ·  📅 ${String(card.dueDate).slice(0, 10)}` });

    if ((card.labels || []).length) {
      const lbls = contentEl.createDiv({ cls: "kan-card-labels" });
      for (const l of card.labels) {
        const span = lbls.createSpan({ cls: "kan-label", text: l.name });
        if (l.colourCode) span.style.background = l.colourCode + "33";
      }
    }

    if ((card.members || []).length) {
      contentEl.createDiv({ cls: "kan-modal-section", text: "👤 " + card.members.map((m) => (m.user && m.user.name) || m.email).join(", ") });
    }

    if (card.description) {
      contentEl.createEl("h5", { text: "Description" });
      contentEl.createDiv({ cls: "kan-modal-desc", text: card.description });
    }

    for (const cl of card.checklists || []) {
      const total = (cl.items || []).length;
      const done = (cl.items || []).filter((i) => i.completed).length;
      contentEl.createEl("h5", { text: `${cl.name} (${done}/${total})` });
      const ul = contentEl.createEl("ul", { cls: "kan-modal-checklist" });
      for (const it of cl.items || []) ul.createEl("li", { text: (it.completed ? "☑ " : "☐ ") + it.title });
    }

    if ((card.attachments || []).length) {
      contentEl.createEl("h5", { text: "Attachments" });
      const ul = contentEl.createEl("ul", { cls: "kan-modal-checklist" });
      for (const a of card.attachments) {
        const li = ul.createEl("li");
        const name = a.originalFilename || a.s3Key;
        if (a.url) li.createEl("a", { text: "📎 " + name, href: a.url });
        else li.setText("📎 " + name);
      }
    }

    // comments + activity
    const acts = card.activities || [];
    contentEl.createEl("h5", { text: "Activity" });
    const feed = contentEl.createDiv({ cls: "kan-modal-activity" });
    if (!acts.length) feed.setText("No activity.");
    for (const a of acts.slice(-15).reverse()) {
      const when = String(a.createdAt).slice(0, 16).replace("T", " ");
      const who = (a.user && (a.user.name || a.user.email)) || "";
      let what = a.type;
      if (a.comment && a.comment.comment) what = `💬 ${a.comment.comment}`;
      else if (a.fromList && a.toList) what = `moved ${a.fromList.name} → ${a.toList.name}`;
      else if (a.toTitle && a.fromTitle) what = `renamed "${a.fromTitle}" → "${a.toTitle}"`;
      else if (a.label) what = `label: ${a.label.name}`;
      else if (a.member) what = `member: ${(a.member.user && a.member.user.name) || ""}`;
      feed.createDiv({ cls: "kan-activity-row", text: `${when} ${who ? "· " + who + " " : ""}· ${what}` });
    }

    // add comment
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
        this.onOpen(); // re-render
      } catch (e) { new Notice("Kan error: " + e.message, 8000); }
    };
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
  }

  getViewType() { return VIEW_TYPE_KAN; }
  getDisplayText() { return "Kan boards"; }
  getIcon() { return "layout-dashboard"; }

  async onOpen() { await this.render(); }

  async render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("kan-view");

    const header = el.createDiv({ cls: "kan-header" });
    const wsSelect = header.createEl("select", { cls: "kan-select kan-ws-select", attr: { "aria-label": "Workspace" } });
    const select = header.createEl("select", { cls: "kan-select" });
    const searchBtn = header.createEl("button", { text: "🔍", cls: "kan-refresh", attr: { "aria-label": "Search" } });
    const refreshBtn = header.createEl("button", { text: "↻", cls: "kan-refresh", attr: { "aria-label": "Refresh" } });
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

    const renderBoard = async () => {
      body.empty();
      body.setText("Loading…");
      let board;
      try { board = await this.plugin.client.getBoard(this.selectedBoardId); }
      catch (e) { body.setText("Error: " + e.message); return; }
      body.empty();
      const cols = body.createDiv({ cls: "kan-columns" });
      for (const list of board.lists || []) {
        const col = cols.createDiv({ cls: "kan-col" });
        col.createDiv({ cls: "kan-col-title", text: `${list.name} (${(list.cards || []).length})` });

        col.addEventListener("dragover", (ev) => { ev.preventDefault(); col.addClass("kan-drop-target"); });
        col.addEventListener("dragleave", () => col.removeClass("kan-drop-target"));
        col.addEventListener("drop", async (ev) => {
          ev.preventDefault();
          col.removeClass("kan-drop-target");
          const cardId = ev.dataTransfer.getData("text/kan-card");
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
            ev.dataTransfer.setData("text/kan-card", card.publicId);
            c.addClass("kan-dragging");
          });
          c.addEventListener("dragend", () => c.removeClass("kan-dragging"));

          // drop on a card = reorder to that card's position within its list
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
      }
    };

    const loadBoards = async () => {
      const ws = this.plugin.settings.workspaceId;
      if (!ws) { body.setText("Set workspace in Settings → Kan Sync."); return; }
      try { this.boards = await this.plugin.client.getBoards(ws); }
      catch (e) { body.setText("Error: " + e.message); return; }
      select.empty();
      for (const b of this.boards) {
        const opt = select.createEl("option", { text: b.name });
        opt.value = b.publicId;
      }
      if (this.boards.length) {
        if (!this.boards.find((b) => b.publicId === this.selectedBoardId)) this.selectedBoardId = this.boards[0].publicId;
        select.value = this.selectedBoardId;
        await renderBoard();
      } else body.setText("No boards in this workspace yet.");
    };

    select.onchange = async () => { this.selectedBoardId = select.value; await renderBoard(); };
    refreshBtn.onclick = async () => { await loadWorkspaces(); await loadBoards(); };
    searchBtn.onclick = () => new KanSearchModal(this.app, this.plugin).open();
    this.reload = loadBoards;
    await loadWorkspaces();
    await loadBoards();
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
          const listId = card.list && card.list.publicId;
          if (!listId) { new Notice("Could not resolve card list."); return; }
          const dup = await this.client.duplicateCard(id, listId, {});
          new Notice(`Duplicated card${dup && dup.publicId ? ` (${dup.publicId})` : ""}.`);
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
        try {
          await this.client.deleteCard(id);
          const cleaned = line.replace(MARKER_RE, "").replace(/\s+$/, "");
          editor.setLine(lineNo, cleaned);
          new Notice("Card deleted in Kan.");
        } catch (e) { new Notice("Kan error: " + e.message, 8000); console.error(e); }
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

  async ensureBoardIdFrontmatter(file, boardId) {
    const existing = this.boardIdForFile(file);
    if (existing === boardId) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.kan_board_id = boardId;
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
        console.warn("Kan: stored kan_board_id not found, falling back to name", e);
      }
    }
    let stub = await this.findBoardByName(boardName);
    if (!stub) {
      const created = await this.client.createBoard(this.settings.workspaceId, boardName, listNames || []);
      stub = { publicId: created.publicId, name: boardName };
    }
    return { stub, board: null };
  }

  async ensureLabels(board, tagNames) {
    const map = {};
    for (const l of board.labels || []) map[l.name.toLowerCase()] = l.publicId;
    for (const tag of tagNames) {
      const key = tag.toLowerCase();
      if (!map[key]) {
        try {
          const created = await this.client.createLabel(board.publicId, tag, labelColour(tag));
          map[key] = created.publicId;
        } catch (e) { console.error("Kan label create failed:", tag, e); }
      }
    }
    return map;
  }

  async syncSubtasksForCard(card, children) {
    // adds missing checklist items AND pushes note-side completion to Kan
    // when allowDeletes: removes Kan checklist items not present in the note
    const clName = this.settings.subtaskChecklistName || "Subtasks";
    let checklist = (card.checklists || []).find((c) => c.name.toLowerCase() === clName.toLowerCase());
    let checklistId = checklist ? checklist.publicId : null;
    const existingByTitle = {};
    for (const i of (checklist && checklist.items) || []) existingByTitle[normTitle(i.title)] = i;

    let added = 0, completed = 0, removed = 0;
    const want = new Set(children.map((c) => normTitle(c.title)));
    for (const child of children) {
      const existing = existingByTitle[normTitle(child.title)];
      if (existing) {
        if (child.done && !existing.completed) {
          await this.client.updateChecklistItem(existing.publicId, { completed: true });
          completed++;
        }
        continue;
      }
      if (!checklistId) {
        const created = await this.client.createChecklist(card.publicId, clName);
        checklistId = created.publicId;
      }
      const ni = await this.client.addChecklistItem(checklistId, child.title);
      added++;
      if (child.done && ni && ni.publicId) {
        await this.client.updateChecklistItem(ni.publicId, { completed: true });
        completed++;
      }
    }
    if (this.settings.allowDeletes && checklist) {
      for (const i of checklist.items || []) {
        if (!want.has(normTitle(i.title))) {
          await this.client.deleteChecklistItem(i.publicId);
          removed++;
        }
      }
    }
    return { added, completed, removed };
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

  async pushChecklist() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("No active note."); return; }
    if (!this.settings.workspaceId) { new Notice("Set workspace in Settings → Kan Sync."); return; }

    const content = await this.app.vault.read(file);
    const { sections, lines } = parseNote(content, this.settings.defaultListName);
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
      await this.ensureBoardIdFrontmatter(file, board.publicId);

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
          const nc = await this.client.createCard(listId, item.title, desc, toIsoDue(item.due), labelIds, memberIds);
          created++;
          if (nc && nc.publicId) noteCardIds.add(nc.publicId);
          if (this.settings.useIdMarkers && nc && nc.publicId) markers.push({ lineNo: item.lineNo, id: nc.publicId });
          if (memberIds.length) assigned += memberIds.length;

          if (this.settings.syncSubtasks && item.children.length && nc && nc.publicId) {
            const r = await this.syncSubtasksForCard({ publicId: nc.publicId, checklists: [] }, item.children);
            subAdded += r.added;
            subCompleted += r.completed;
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
        catch (e) { console.warn("Kan: kan_board_id missing on pull, falling back to name", e); }
      }
      if (!board) {
        const byName = await this.findBoardByName(boardName);
        if (!byName) { if (!silent) new Notice(`No Kan board named "${boardName}".`); return; }
        board = await this.client.getBoard(byName.publicId);
      }

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
      .setDesc("Click Detect to load your workspaces, then pick one.")
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
            await this.plugin.saveSettings();
            new Notice(`Workspace set: ${wss[0].name || wss[0].publicId}${wss.length > 1 ? ` (+${wss.length - 1} more — see console)` : ""}`);
            console.log("Kan workspaces:", wss);
            this.display();
          } catch (e) { new Notice("Kan error: " + e.message, 8000); }
        })
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
  }
}

module.exports = KanSyncPlugin;
