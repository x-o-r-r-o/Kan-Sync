/* Kan Sync v0.5.1 — plugin for Kan.bn
 * https://github.com/x-o-r-r-o/
 *
 * v0.5.1: Fix community manifest description (remove banned word).
 * v0.5.0: @person member sync, card detail modal (description, checklists,
 * attachments, comments, activity), multi-workspace switcher in board view.
 */

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, requestUrl, Modal, SuggestModal } = require("obsidian");

const VIEW_TYPE_KAN = "kan-board-view";
const MARKER_RE = /\s*%%kan:([\w-]+)%%/;
const DUE_RE = /(?:📅|@due\()\s*(\d{4}-\d{2}-\d{2})\)?/u;
const TAG_RE = /(^|\s)#([\w/-]+)/g;
const MENTION_RE = /(^|\s)@([\w.-]+)/g;
const LABEL_COLOURS = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#34495e"];

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
  createCard(listId, title, description, dueDate, labelPublicIds) {
    return this.req("POST", "/cards", {
      title: title.slice(0, 2000),
      description: (description || "").slice(0, 10000),
      listPublicId: listId,
      labelPublicIds: labelPublicIds || [],
      memberPublicIds: [],
      position: "end",
      dueDate: dueDate || null,
    });
  }
  updateCard(cardId, patch) { return this.req("PUT", `/cards/${cardId}`, patch); }
  createLabel(boardId, name, colourCode) {
    return this.req("POST", "/labels", { name: name.slice(0, 36), boardPublicId: boardId, colourCode });
  }
  toggleCardLabel(cardId, labelId) { return this.req("PUT", `/cards/${cardId}/labels/${labelId}`); }
  addComment(cardId, comment) { return this.req("POST", `/cards/${cardId}/comments`, { comment }); }
  createChecklist(cardId, name) { return this.req("POST", `/cards/${cardId}/checklists`, { name: name.slice(0, 255) }); }
  addChecklistItem(checklistId, title) { return this.req("POST", `/checklists/${checklistId}/items`, { title: title.slice(0, 500) }); }
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

// Parse note → sections with items and nested sub-items.
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
    if (!m) return;
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
      lastTopItem = { done: m[2] !== " ", title, kanId, due, tags, mentions, lineNo, children: [] };
      current.items.push(lastTopItem);
    } else if (lastTopItem) {
      lastTopItem.children.push({ done: m[2] !== " ", title, lineNo });
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

  async findBoardByName(name) {
    const boards = await this.client.getBoards(this.settings.workspaceId);
    return boards.find((b) => b.name.toLowerCase() === name.toLowerCase()) || null;
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
    // adds missing checklist items AND pushes note-side completion to Kan (additive: never un-completes)
    const clName = this.settings.subtaskChecklistName || "Subtasks";
    let checklist = (card.checklists || []).find((c) => c.name.toLowerCase() === clName.toLowerCase());
    let checklistId = checklist ? checklist.publicId : null;
    const existingByTitle = {};
    for (const i of (checklist && checklist.items) || []) existingByTitle[normTitle(i.title)] = i;

    let added = 0, completed = 0;
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
    return { added, completed };
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

  async syncMembersForCard(cardPublicId, currentMemberIds, mentions, wsMembers) {
    // add-only: assign mentioned members the card doesn't have yet
    let assigned = 0;
    for (const mention of mentions) {
      const member = this.resolveMention(mention, wsMembers);
      if (!member) { console.warn(`Kan: no workspace member matches @${mention}`); continue; }
      if (currentMemberIds.has(member.publicId)) continue;
      await this.client.toggleCardMember(cardPublicId, member.publicId);
      currentMemberIds.add(member.publicId);
      assigned++;
    }
    return assigned;
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
      let stub = await this.findBoardByName(boardName);
      if (!stub) {
        const created = await this.client.createBoard(this.settings.workspaceId, boardName, sections.map((s) => s.name));
        stub = { publicId: created.publicId };
      }
      const board = await this.client.getBoard(stub.publicId);

      const listMap = {};
      for (const l of board.lists || []) listMap[l.name.toLowerCase()] = l.publicId;
      for (const s of sections) {
        if (!listMap[s.name.toLowerCase()]) {
          const nl = await this.client.createList(board.publicId, s.name);
          listMap[s.name.toLowerCase()] = nl.publicId;
        }
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
      const wsMembers = (board.workspace && board.workspace.members) || [];

      let created = 0, updated = 0, adopted = 0, moved = 0, subAdded = 0, subCompleted = 0, labeled = 0, assigned = 0;
      const markers = [];

      for (const s of sections) {
        const listId = listMap[s.name.toLowerCase()];
        for (const item of s.items) {
          const existing = item.kanId ? cardsById[item.kanId] : cardsByTitle[normTitle(item.title)];

          if (existing) {
            if (!item.kanId && this.settings.useIdMarkers) { markers.push({ lineNo: item.lineNo, id: existing.publicId }); adopted++; }

            const patch = {};
            if (item.kanId && normTitle(existing.title) !== normTitle(item.title)) patch.title = item.title;
            const existingDue = existing.dueDate ? String(existing.dueDate).slice(0, 10) : null;
            if (item.due && item.due !== existingDue) patch.dueDate = toIsoDue(item.due);
            if (Object.keys(patch).length) { await this.client.updateCard(existing.publicId, patch); updated++; }

            // retro-label: add labels for tags the card doesn't have yet (never removes)
            if (this.settings.syncTags && this.settings.retroLabel && item.tags.length) {
              const have = new Set((existing.labels || []).map((l) => l.name.toLowerCase()));
              for (const tag of item.tags) {
                if (!have.has(tag.toLowerCase()) && labelMap[tag.toLowerCase()]) {
                  await this.client.toggleCardLabel(existing.publicId, labelMap[tag.toLowerCase()]);
                  labeled++;
                }
              }
            }

            // @mentions → card members (add-only)
            if (this.settings.syncMembers && item.mentions.length) {
              const have = new Set((existing.members || []).map((m) => m.publicId));
              assigned += await this.syncMembersForCard(existing.publicId, have, item.mentions, wsMembers);
            }

            // sub-items → card checklist (two-way completion: note done → Kan completed)
            if (this.settings.syncSubtasks && item.children.length) {
              const r = await this.syncSubtasksForCard(existing, item.children);
              subAdded += r.added;
              subCompleted += r.completed;
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
          const nc = await this.client.createCard(listId, item.title, `From Obsidian: ${file.path}`, toIsoDue(item.due), labelIds);
          created++;
          if (this.settings.useIdMarkers && nc && nc.publicId) markers.push({ lineNo: item.lineNo, id: nc.publicId });

          if (this.settings.syncSubtasks && item.children.length && nc && nc.publicId) {
            const r = await this.syncSubtasksForCard({ publicId: nc.publicId, checklists: [] }, item.children);
            subAdded += r.added;
            subCompleted += r.completed;
          }

          if (this.settings.syncMembers && item.mentions.length && nc && nc.publicId)
            assigned += await this.syncMembersForCard(nc.publicId, new Set(), item.mentions, wsMembers);
        }
      }

      if (markers.length) {
        for (const m of markers) if (!MARKER_RE.test(lines[m.lineNo])) lines[m.lineNo] += ` %%kan:${m.id}%%`;
        await this.app.vault.modify(file, lines.join("\n"));
      }

      const bits = [`${created} created`, `${updated} updated`];
      if (adopted) bits.push(`${adopted} linked`);
      if (moved) bits.push(`${moved} moved to done`);
      if (subAdded) bits.push(`${subAdded} subtasks`);
      if (subCompleted) bits.push(`${subCompleted} subtasks completed`);
      if (labeled) bits.push(`${labeled} labels`);
      if (assigned) bits.push(`${assigned} assigned`);
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
      const stub = await this.findBoardByName(boardName);
      if (!stub) { if (!silent) new Notice(`No Kan board named "${boardName}".`); return; }
      const board = await this.client.getBoard(stub.publicId);

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
      let currentCardId = null;

      content = content.split("\n").map((line) => {
        const top = line.match(/^-\s*\[( |x|X)\]\s+(.*)/);
        if (top) {
          currentCardId = (top[2].match(MARKER_RE) || [])[1] || null;
          if (top[1] === " ") {
            const isDone = currentCardId ? doneIds.has(currentCardId) : doneTitles.has(normTitle(top[2]));
            if (isDone) { checked++; return line.replace("[ ]", "[x]"); }
          }
          return line;
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
      if (!silent) new Notice(`Kan: status pulled. ${checked} item(s) checked off.`);
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
      .setDesc("When you add a #tag to an already-synced item, add the label to its card on next push. Never removes labels.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.retroLabel)
          .onChange(async (v) => { this.plugin.settings.retroLabel = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Sync @mentions as card members")
      .setDesc("@name on an item assigns the matching workspace member (by name or email prefix) to its card. Add-only.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncMembers)
          .onChange(async (v) => { this.plugin.settings.syncMembers = v; await this.plugin.saveSettings(); })
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
