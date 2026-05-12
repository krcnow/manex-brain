const {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  MarkdownRenderer,
  TFile
} = require("obsidian");

const { spawn, execFile } = require("child_process");

const VIEW_TYPE_MANEX_STUDY_ROOM = "manex-study-room-view";
const URL_PAYLOAD_LIMIT = 150000;
const CONTEXT_CHAR_LIMIT = 28000;
const ANSWER_CONTEXT_CHAR_LIMIT = 18000;
const GRAPH_NOTE_CHAR_LIMIT = 5000;
const GRAPH_CONTEXT_LIMIT = 12;
const LOCAL_BRAIN_LIMIT = 500;
const LOCAL_BRAIN_RETRIEVAL_LIMIT = 10;
const TOP_CHUNKS = 6;
const TOP_VAULT_CHUNKS = 4;
const CHUNK_SIZE = 900;

const MLX_BASE_URL = "http://localhost:8080";
const MLX_MODEL = "mlx-community/Qwen3-4B-4bit";

const DEFAULT_SETTINGS = {
  includeFrontmatter: false,
  localBrain: []
};

class ManexStudyRoomPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.localBrain)) {
      this.settings.localBrain = [];
    }

    this.registerView(
      VIEW_TYPE_MANEX_STUDY_ROOM,
      (leaf) => new ManexStudyRoomView(leaf, this)
    );

    this.addRibbonIcon("brain-circuit", "Open Manex Brain", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-study-room",
      name: "Open Manex Brain web app",
      callback: () => window.open("https://manex.app", "_blank")
    });

    this.addCommand({
      id: "open-study-room-chat",
      name: "Open Manex Brain panel",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "ask-current-note",
      name: "Ask Study Room about current note",
      checkCallback: (checking) => {
        const view = this.getMarkdownView();
        if (!view) return false;
        if (!checking) this.askCurrentNote(view);
        return true;
      }
    });

    this.addSettingTab(new ManexStudyRoomSettingTab(this.app, this));

    this.mlxProcess = null;
    this.unloading = false;
    this.vaultIndex = {};
    this.vaultIndexProgress = { indexed: 0, total: 0, done: false };

    this.loadVaultIndex();
    this.startMlxBackend();
    this.indexVaultInBackground();

    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.indexFile(file).then(() => this.saveVaultIndex()).catch(() => {});
      }
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.indexFile(file).then(() => this.saveVaultIndex()).catch(() => {});
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && this.vaultIndex[file.path]) {
        delete this.vaultIndex[file.path];
        this.saveVaultIndex();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && this.vaultIndex[oldPath]) {
        this.vaultIndex[file.path] = this.vaultIndex[oldPath];
        this.vaultIndex[file.path].title = file.basename;
        delete this.vaultIndex[oldPath];
        this.saveVaultIndex();
      }
    }));
  }

  onunload() {
    this.unloading = true;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MANEX_STUDY_ROOM);
    this.saveVaultIndex();
    if (this.mlxProcess) {
      this.mlxProcess.kill();
      this.mlxProcess = null;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getMarkdownView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView)
      || this.app.workspace.getLeavesOfType("markdown")
        .map((leaf) => leaf.view)
        .find((view) => view instanceof MarkdownView && view.file);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MANEX_STUDY_ROOM)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return existing.view;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_MANEX_STUDY_ROOM, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  getMlxBaseUrl() {
    return MLX_BASE_URL;
  }

  getMlxPort() {
    try { return parseInt(new URL(this.getMlxBaseUrl()).port) || 8080; }
    catch { return 8080; }
  }

  async checkMlxServer() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${this.getMlxBaseUrl()}/v1/models`, { signal: controller.signal });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitForMlxServer(maxMs = 300000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (await this.checkMlxServer()) return true;
      await new Promise((r) => setTimeout(r, 4000));
    }
    return false;
  }

  findSystemPython() {
    const fs = require("fs");
    const candidates = [
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      "/opt/homebrew/bin/python",
      "/usr/local/bin/python",
    ];
    for (const p of candidates) {
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
    return null;
  }

  findHomebrew() {
    const fs = require("fs");
    const candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
    for (const p of candidates) {
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
    return null;
  }

  async ensurePython() {
    const python = this.findSystemPython();
    if (python) return python;

    const brew = this.findHomebrew();
    if (brew) {
      new Notice("Manex Brain: Python not found — installing via Homebrew (this may take a few minutes)…");
      await this.runCommand(brew, ["install", "python3"]);
      const installed = this.findSystemPython();
      if (installed) return installed;
      throw new Error("Python installed but still not found — restart Obsidian and try again.");
    }

    throw new Error(
      "Python 3 is required but not installed. Install it from https://python.org or via Homebrew (brew install python), then restart Obsidian."
    );
  }

  getVenvPath() {
    const { join } = require("path");
    const { homedir } = require("os");
    return join(homedir(), ".obsidian-study-room", "venv");
  }

  getVenvPython() {
    return require("path").join(this.getVenvPath(), "bin", "python3");
  }

  isMlxLmInstalled(python) {
    return new Promise((resolve) => {
      execFile(python, ["-c", "import mlx_lm"], (error) => resolve(!error));
    });
  }

  runCommand(python, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(python, args, { stdio: "pipe" });
      let stderr = "";
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exited with code ${code}`))));
      proc.on("error", (err) => reject(new Error(`Could not run ${python}: ${err.message}`)));
    });
  }

  async ensureVenvReady() {
    const fs = require("fs");
    const venvPython = this.getVenvPython();
    const systemPython = await this.ensurePython();
    console.log(`[Study Room] System Python: ${systemPython}`);

    if (!fs.existsSync(venvPython)) {
      new Notice("Study Room: Creating Python environment…");
      await this.runCommand(systemPython, ["-m", "venv", this.getVenvPath()]);
      console.log(`[Study Room] Venv created at ${this.getVenvPath()}`);
    }

    const installed = await this.isMlxLmInstalled(venvPython);
    if (!installed) {
      new Notice("Study Room: Installing mlx-lm…");
      await this.runCommand(venvPython, ["-m", "pip", "install", "--upgrade", "mlx-lm"]);
      new Notice("Study Room: mlx-lm installed.");
    }

    return venvPython;
  }

  spawnMlxServer(python) {
    const proc = spawn(
      python,
      ["-m", "mlx_lm.server", "--model", MLX_MODEL, "--port", String(this.getMlxPort())],
      { stdio: "pipe" }
    );
    proc.on("error", (err) => console.error("[Study Room] MLX process error:", err));
    proc.stdout?.on("data", (d) => console.log("[MLX]", d.toString().trim()));
    proc.stderr?.on("data", (d) => console.log("[MLX]", d.toString().trim()));
    return proc;
  }

  async startMlxBackend() {
    if (await this.checkMlxServer()) return;

    try {
      const venvPython = await this.ensureVenvReady();
      this.mlxProcess = this.spawnMlxServer(venvPython);
      new Notice("Study Room: Starting Qwen3-4B — downloading on first run (~2.3 GB)…");

      const ready = await this.waitForMlxServer();
      if (ready) {
        new Notice("Study Room: MLX server ready.");
        this.app.workspace.getLeavesOfType(VIEW_TYPE_MANEX_STUDY_ROOM)
          .forEach((leaf) => { if (leaf.view instanceof ManexStudyRoomView) leaf.view.embedContext(); });
      } else {
        new Notice("Study Room: MLX server is still loading — answers will work once the model is ready.");
      }
    } catch (err) {
      new Notice(`Study Room: Could not start MLX server — ${err.message}`);
      console.error("[Study Room] MLX startup error:", err);
    }
  }

  getIndexPath() {
    return require("path").join(require("os").homedir(), ".obsidian-study-room", "vault-index.json");
  }

  loadVaultIndex() {
    try {
      const raw = require("fs").readFileSync(this.getIndexPath(), "utf8");
      this.vaultIndex = JSON.parse(raw);
    } catch {
      this.vaultIndex = {};
    }
  }

  saveVaultIndex() {
    const fs = require("fs");
    const path = this.getIndexPath();
    const dir = require("path").dirname(path);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path, JSON.stringify(this.vaultIndex), "utf8");
    } catch (err) {
      console.warn("[Study Room] Could not save vault index:", err);
    }
  }

  async indexFile(file) {
    const content = await this.app.vault.cachedRead(file);
    const body = stripFrontmatter(this.settings.includeFrontmatter ? content : content);
    const hash = stableHash(body);
    if (this.vaultIndex[file.path]?.hash === hash) return;
    this.vaultIndex[file.path] = {
      title: file.basename,
      hash,
      indexedAt: Date.now(),
      chunks: chunkText(body, CHUNK_SIZE)
    };
  }

  async indexVaultInBackground() {
    await new Promise((r) => setTimeout(r, 3000));
    const files = this.app.vault.getMarkdownFiles();
    this.vaultIndexProgress = { indexed: 0, total: files.length, done: false };
    this.notifyVaultProgress();

    let saved = 0;
    for (const file of files) {
      if (this.unloading) break;
      try {
        await this.indexFile(file);
      } catch (err) {
        console.warn(`[Study Room] Could not index ${file.path}:`, err);
      }
      this.vaultIndexProgress.indexed++;
      saved++;
      if (saved % 50 === 0) {
        this.saveVaultIndex();
        this.notifyVaultProgress();
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    this.saveVaultIndex();
    this.vaultIndexProgress.done = true;
    this.notifyVaultProgress();
    console.log(`[Study Room] Vault indexed: ${files.length} notes.`);
  }

  notifyVaultProgress() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_MANEX_STUDY_ROOM)
      .forEach((leaf) => { if (leaf.view instanceof ManexStudyRoomView) leaf.view.render(); });
  }

  searchVault(question, excludePath = "", topK = TOP_VAULT_CHUNKS) {
    const results = [];
    for (const [path, entry] of Object.entries(this.vaultIndex)) {
      if (path === excludePath) continue;
      for (const text of entry.chunks) {
        const score = scoreText(question, `${entry.title} ${text}`);
        if (score > 0) results.push({ text, score, sourcePath: path, title: entry.title });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async embedTexts(texts) {
    const baseUrl = this.getMlxBaseUrl();
    const response = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: texts,
        model: MLX_MODEL
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `MLX embedding error (${response.status})`);
    }
    const data = await response.json();
    return (data.data || []).map((item) => item.embedding);
  }

  async answerFromMLX({ question, context, chatHistory = [], relevantChunks = [], vaultChunks = [] }) {
    const baseUrl = this.getMlxBaseUrl();
    const localBrain = this.getRelevantLocalBrain(question, context);
    const systemContent = buildSystemPrompt(context, relevantChunks, localBrain, vaultChunks);

    const messages = [
      { role: "system", content: systemContent },
      ...chatHistory.flatMap((turn) => [
        { role: "user", content: turn.question },
        { role: "assistant", content: turn.answer }
      ]),
      { role: "user", content: question }
    ];

    let response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MLX_MODEL,
          messages,
          max_tokens: 1024,
          temperature: 0.3,
          stream: false
        })
      });
    } catch (err) {
      throw new Error(`MLX server not reachable at ${baseUrl}. Start it with: mlx_lm.server --model <model-path>`);
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `MLX server error (${response.status})`);
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || "";
    if (!answer) throw new Error("MLX returned an empty answer.");

    return {
      answer,
      sources: relevantChunks.map((chunk, i) => ({
        label: `${context.sourcePath} · section ${i + 1}`,
        text: truncateText(chunk.text, 240),
        score: chunk.score
      })),
      mode: "mlx-local",
      model: data.model || MLX_MODEL
    };
  }

  async getCurrentNotePayload(view = this.getMarkdownView()) {
    const file = view?.file;
    if (!file) return null;
    const content = await this.app.vault.read(file);
    const graphContext = await this.collectGraphContext(file);
    return {
      title: file.basename,
      sourcePath: file.path,
      body: this.settings.includeFrontmatter ? content : stripFrontmatter(content),
      graphContext
    };
  }

  async collectGraphContext(file) {
    if (!file) return [];
    const metadata = this.app.metadataCache;
    const outgoingPaths = new Set();
    const resolved = metadata.resolvedLinks?.[file.path] || {};
    for (const linkedPath of Object.keys(resolved)) {
      if (linkedPath !== file.path) outgoingPaths.add(linkedPath);
    }

    const backlinkPaths = new Set();
    for (const [sourcePath, links] of Object.entries(metadata.resolvedLinks || {})) {
      if (sourcePath !== file.path && links?.[file.path]) backlinkPaths.add(sourcePath);
    }

    const cache = metadata.getFileCache(file) || {};
    const currentTags = new Set((cache.tags || []).map((tag) => tag.tag).filter(Boolean));
    const folder = file.parent?.path || "";
    const candidates = [];
    for (const note of this.app.vault.getMarkdownFiles()) {
      if (note.path === file.path) continue;
      let score = 0;
      const reasons = [];
      if (outgoingPaths.has(note.path)) {
        score += 12;
        reasons.push("linked from current note");
      }
      if (backlinkPaths.has(note.path)) {
        score += 10;
        reasons.push("links to current note");
      }
      if (folder && note.parent?.path === folder) {
        score += 3;
        reasons.push("same folder");
      }
      const noteCache = metadata.getFileCache(note) || {};
      const sharedTags = (noteCache.tags || [])
        .map((tag) => tag.tag)
        .filter((tag) => currentTags.has(tag));
      if (sharedTags.length) {
        score += Math.min(8, sharedTags.length * 3);
        reasons.push(`shared tags ${sharedTags.slice(0, 3).join(", ")}`);
      }
      if (score > 0) candidates.push({ file: note, score, reasons });
    }

    candidates.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const graphContext = [];
    for (const candidate of candidates.slice(0, GRAPH_CONTEXT_LIMIT)) {
      const content = await this.app.vault.cachedRead(candidate.file);
      graphContext.push({
        title: candidate.file.basename,
        sourcePath: candidate.file.path,
        relation: candidate.reasons.join("; "),
        score: candidate.score,
        body: truncateText(stripFrontmatter(content), GRAPH_NOTE_CHAR_LIMIT)
      });
    }
    return graphContext;
  }

  getSelectionPayload(view = this.getMarkdownView()) {
    const file = view?.file;
    const selection = view?.editor?.getSelection?.() || "";
    if (!selection.trim()) return null;
    return {
      title: file ? `${file.basename} selection` : "Obsidian selection",
      sourcePath: file ? file.path : "Untitled",
      body: selection
    };
  }

  async askCurrentNote(view = this.getMarkdownView()) {
    const panel = await this.activateView();
    if (panel?.ingestCurrentNote) {
      await panel.ingestCurrentNote(view);
    }
  }

  classifyTurn(text) {
    return classifyStudyTurn(text);
  }

  getRelevantLocalBrain(question, context = {}) {
    const memories = Array.isArray(this.settings.localBrain) ? this.settings.localBrain : [];
    const query = [question, context.title || "", context.sourcePath || ""].join(" ");
    return memories
      .map((memory) => ({
        ...memory,
        score: scoreLocalBrainMemory(query, memory)
      }))
      .filter((memory) => memory.score > 0 || memory.sourcePath === context.sourcePath)
      .sort((a, b) => {
        const priority = { correction: 4, decision: 3, answer: 2, question: 1, comment: 1 };
        return (priority[b.type] || 0) - (priority[a.type] || 0)
          || b.score - a.score
          || Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
      })
      .slice(0, LOCAL_BRAIN_RETRIEVAL_LIMIT);
  }

  async rememberTurn({ type, text, question = "", answer = "", context = {}, sources = [] }) {
    const now = Date.now();
    const memories = Array.isArray(this.settings.localBrain) ? this.settings.localBrain : [];
    const sourcePath = context?.sourcePath || "";
    const title = context?.title || "Study Room";
    const memoryText = normalizeWhitespace(text || [question, answer].filter(Boolean).join(" "));
    if (!memoryText) return null;
    const relatedIds = memories
      .map((memory) => ({
        id: memory.id,
        score: scoreLocalBrainMemory(`${title} ${sourcePath} ${memoryText}`, memory)
          + (memory.sourcePath && memory.sourcePath === sourcePath ? 4 : 0)
      }))
      .filter((item) => item.id && item.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((item) => item.id);
    const memory = {
      id: `brain-${now}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      title,
      sourcePath,
      text: memoryText,
      question: normalizeWhitespace(question),
      answer: normalizeWhitespace(answer),
      sources: Array.isArray(sources) ? sources.slice(0, 5).map((source) => source.label || source.text || String(source)) : [],
      relatedIds,
      createdAt: now,
      updatedAt: now
    };
    this.settings.localBrain = [memory, ...memories].slice(0, LOCAL_BRAIN_LIMIT);
    await this.saveSettings();
    return memory;
  }

  async saveSelectionAsMemory(view = this.getMarkdownView()) {
    const selection = view?.editor?.getSelection?.().trim();
    if (!selection) {
      new Notice("Select the answer, correction, or decision first.");
      return;
    }

    const file = view.file;
    const modal = new MemoryModal(this.app, {
      defaultTitle: file ? `Memory from ${file.basename}` : "Study memory",
      defaultText: selection,
      onSubmit: async ({ title, type, text }) => {
        await this.createMemoryNote({ title, type, text, sourcePath: file ? file.path : "" });
      }
    });
    modal.open();
  }

  async createMemoryNote({ title, type, text, sourcePath, appendPath = "" }) {
    await ensureFolder(this.app, "Manex Memories");
    const stamp = new Date().toISOString().slice(0, 10);
    const safeTitle = sanitizeFileName(title || "Study memory");
    const path = appendPath && this.app.vault.getAbstractFileByPath(appendPath)
      ? appendPath
      : await uniquePath(this.app, `${"Manex Memories"}/${stamp} - ${safeTitle}.md`);
    const entry = [
      "",
      `## ${type === "correction" ? "Correction" : type === "decision" ? "Decision" : "Saved answer"} - ${new Date().toLocaleString()}`,
      "",
      String(text || "").trim(),
      ""
    ].join("\n");
    if (appendPath && this.app.vault.getAbstractFileByPath(appendPath)) {
      await this.app.vault.append(appendPath, entry);
    } else {
      const content = [
        "---",
        "manex: memory",
        `type: ${type || "note"}`,
        `source: ${JSON.stringify(sourcePath || "Obsidian")}`,
        `created: ${new Date().toISOString()}`,
        "---",
        "",
        `# ${title || "Study memory"}`,
        entry,
        "",
        "## Reuse note",
        "Use this as corrected or accepted study context in future Study Room questions."
      ].join("\n");

      await this.app.vault.create(path, content);
    }
    new Notice(`${appendPath ? "Appended" : "Saved"} to vault: ${path}`);
    return path;
  }
}

class ManexStudyRoomView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.context = null;
    this.contextChunks = [];
    this.chunkEmbeddings = null;
    this.embeddingStatus = "";
    this.messages = [];
    this.busy = false;
    this.threadMemoryPath = "";
  }

  getViewType() {
    return VIEW_TYPE_MANEX_STUDY_ROOM;
  }

  getDisplayText() {
    return "Manex Brain";
  }

  getIcon() {
    return "brain-circuit";
  }

  async onOpen() {
    this.render();
    await this.ingestCurrentNote(undefined, true);
    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (file && this.context?.sourcePath !== file.path) {
          await this.ingestCurrentNote(undefined, true);
        }
      })
    );
  }

  async ingestCurrentNote(view = this.plugin.getMarkdownView(), silent = false) {
    const payload = await this.plugin.getCurrentNotePayload(view);
    if (!payload) {
      if (!silent) new Notice("Open a note first.");
      return;
    }
    await this.setContext(payload, silent ? null : "Current note loaded.");
  }

  async ingestSelection(view = this.plugin.getMarkdownView()) {
    const payload = this.plugin.getSelectionPayload(view);
    if (!payload) {
      new Notice("Select some text first.");
      return;
    }
    await this.setContext(payload, "Selected text loaded.");
  }

  async setContext(payload, notice) {
    const nextSourcePath = payload.sourcePath || "Obsidian";
    if (this.context?.sourcePath && this.context.sourcePath !== nextSourcePath) {
      this.threadMemoryPath = "";
    }
    const body = truncateText(String(payload.body || "").trim(), CONTEXT_CHAR_LIMIT);
    const graphContext = Array.isArray(payload.graphContext) ? payload.graphContext : [];
    const graphHashInput = graphContext
      .map((item) => `${item.sourcePath || item.title || ""}:${stableHash(item.body || "")}`)
      .join("|");
    this.context = {
      title: payload.title || "Obsidian note",
      sourcePath: nextSourcePath,
      body,
      graphContext,
      contentHash: stableHash(`${nextSourcePath}:${body}:${graphHashInput}`)
    };
    this.contextChunks = chunkText(body, CHUNK_SIZE);
    this.chunkEmbeddings = null;
    this.embeddingStatus = "loading";
    this.render();
    if (notice) new Notice(notice);
    this.embedContext();
  }

  async embedContext() {
    if (!this.context || !this.contextChunks.length) return;
    try {
      this.chunkEmbeddings = await this.plugin.embedTexts(this.contextChunks);
      this.embeddingStatus = "loaded";
    } catch (error) {
      console.warn("MLX embedding unavailable, using keyword scoring.", error);
      this.chunkEmbeddings = null;
      this.embeddingStatus = "keyword-fallback";
    }
    this.render();
  }

  async getRelevantChunks(question) {
    const chunks = this.contextChunks;
    let noteChunks = [];

    if (chunks.length) {
      if (this.chunkEmbeddings && this.chunkEmbeddings.length === chunks.length) {
        try {
          const [questionEmbedding] = await this.plugin.embedTexts([question]);
          noteChunks = chunks
            .map((text, i) => ({ text, score: cosineScore(questionEmbedding, this.chunkEmbeddings[i]) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_CHUNKS);
        } catch (error) {
          console.warn("Query embedding failed, falling back to keyword scoring.", error);
        }
      }
      if (!noteChunks.length) {
        noteChunks = chunks
          .map((text, i) => ({ text, index: i, score: scoreText(question, `${this.context?.title || ""} ${text}`) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, TOP_CHUNKS);
      }
    }

    const vaultChunks = this.plugin.searchVault(question, this.context?.sourcePath || "");
    return { noteChunks, vaultChunks };
  }

  async ask(question) {
    const cleanQuestion = normalizeWhitespace(question);
    if (!cleanQuestion || this.busy) return;
    const turnType = this.plugin.classifyTurn(cleanQuestion);
    if (!this.context) {
      await this.ingestCurrentNote();
    }
    if (!this.context) return;

    if (turnType !== "question") {
      const memory = await this.plugin.rememberTurn({
        type: turnType,
        text: cleanQuestion,
        context: this.context
      });
      this.messages.push({ role: "user", text: cleanQuestion, turnType, createdAt: Date.now() });
      this.messages.push({
        role: "assistant",
        text: turnType === "correction"
          ? "Noted. Saved as a correction in the local brain and will prioritize it in future answers."
          : "Noted. Saved in the local brain for future context.",
        mode: "local-brain-memory",
        turnType,
        memoryId: memory?.id || "",
        createdAt: Date.now()
      });
      this.render();
      return;
    }

    this.busy = true;
    this.messages.push({ role: "user", text: cleanQuestion, turnType, createdAt: Date.now() });
    this.render();

    try {
      const { noteChunks, vaultChunks } = await this.getRelevantChunks(cleanQuestion);
      const result = await this.plugin.answerFromMLX({
        question: cleanQuestion,
        context: this.context,
        chatHistory: this.getRecentChatHistory(),
        relevantChunks: noteChunks,
        vaultChunks
      });
      this.messages.push({
        role: "assistant",
        text: normalizeAnswer(result.answer),
        sources: result.sources || [],
        mode: result.mode || "mlx-local",
        model: result.model || "",
        question: cleanQuestion,
        contextTitle: this.context.title,
        contextPath: this.context.sourcePath,
        createdAt: Date.now()
      });
      await this.plugin.rememberTurn({
        type: "answer",
        question: cleanQuestion,
        answer: normalizeAnswer(result.answer),
        text: `Question: ${cleanQuestion}\nAnswer: ${normalizeAnswer(result.answer)}`,
        context: this.context,
        sources: result.sources || []
      });
    } catch (error) {
      this.messages.push({
        role: "assistant",
        text: `Could not answer: ${error.message || "Check that the MLX server is running."}`,
        error: true,
        createdAt: Date.now()
      });
    } finally {
      this.busy = false;
      this.render();
    }
  }

  getRecentChatHistory() {
    const turns = [];
    for (let index = 0; index < this.messages.length; index += 1) {
      const current = this.messages[index];
      const next = this.messages[index + 1];
      if (current?.role === "user" && next?.role === "assistant") {
        turns.push({
          question: truncateText(current.text || "", 800),
          answer: truncateText(next.text || "", 1400)
        });
      }
    }
    return turns.slice(-4);
  }

  async saveAssistantMessage(message, type = "answer") {
    const title = `Study Room thread: ${this.context?.title || "Study Room"}`;
    const text = [
      message.question ? `Question: ${message.question}` : "",
      "",
      message.text,
      message.sources?.length
        ? `\nSources:\n${message.sources.map((source) => `- ${source.label || source.text || source}`).join("\n")}`
        : ""
    ].filter(Boolean).join("\n");
    const path = await this.plugin.createMemoryNote({
      title,
      type,
      text,
      sourcePath: message.contextPath || this.context?.sourcePath || "Study Room chat",
      appendPath: this.threadMemoryPath
    });
    this.threadMemoryPath = path;
  }

  openCorrectionModal(message) {
    const modal = new MemoryModal(this.app, {
      defaultTitle: `Correction: ${this.context?.title || "Study Room"}`,
      defaultText: message.text,
      defaultType: "correction",
      onSubmit: async ({ title, type, text }) => {
        const path = await this.plugin.createMemoryNote({
          title: this.threadMemoryPath ? `Study Room thread: ${this.context?.title || "Study Room"}` : title,
          type,
          text,
          sourcePath: message.contextPath || this.context?.sourcePath || "Study Room chat",
          appendPath: this.threadMemoryPath
        });
        this.threadMemoryPath = path;
      }
    });
    modal.open();
  }

  render() {
    this.contentEl.empty();
    this.contentEl.style.position = "relative";
    const container = this.contentEl.createDiv({ cls: "manex-study-room-panel" });

    const scroll = container.createDiv({ cls: "manex-scroll-area" });

    const vp = this.plugin.vaultIndexProgress;
    const vaultStatus = vp && !vp.done
      ? `Indexing ${vp.indexed} / ${vp.total} notes…`
      : vp?.done
        ? `${vp.total} notes indexed`
        : "";

    const header = scroll.createDiv({ cls: "manex-panel-header" });
    header.createEl("h2", { text: "Manex Brain" });
    if (vaultStatus) header.createEl("p", { text: vaultStatus, cls: "manex-vault-status" });

    const chat = scroll.createDiv({ cls: "manex-chat-log" });
    if (!this.messages.length) {
      const empty = chat.createDiv({ cls: "manex-empty" });
      empty.createEl("strong", { text: "Ask anything about your notes." });
      empty.createEl("span", { text: "Try: What are the main arguments? Summarise this. What did we decide about X?" });
    }
    for (const group of this.getDisplayMessageGroups()) {
      for (const message of group) {
        const bubble = chat.createDiv({ cls: `manex-message manex-message-${message.role}${message.error ? " is-error" : ""}` });
        bubble.createEl("div", { cls: "manex-message-label", text: message.role === "user" ? "You" : "Assistant" });
        const messageText = bubble.createDiv({ cls: "manex-message-text" });
        if (message.role === "assistant" && !message.error) {
          MarkdownRenderer.renderMarkdown(message.text, messageText, message.contextPath || "", this);
          messageText.querySelectorAll("a[href]").forEach((a) => {
            a.addEventListener("click", (e) => {
              e.preventDefault();
              const href = a.getAttribute("href") || "";
              this.app.workspace.openLinkText(href.replace(/\.md$/, ""), message.contextPath || "", false);
            });
          });
        } else {
          messageText.setText(message.text);
        }
        if (message.mode || message.model) {
          const meta = bubble.createDiv({ cls: "manex-message-meta" });
          if (message.turnType) meta.createEl("span", { text: message.turnType });
          if (message.mode) meta.createEl("span", { text: message.mode.replace(/-/g, " ") });
          if (message.model) meta.createEl("span", { text: message.model });
        }
        if (message.sources?.length) {
          const sources = bubble.createDiv({ cls: "manex-sources" });
          sources.createEl("span", { text: "Grounding" });
          for (const source of message.sources.slice(0, 3)) {
            const label = source.label || source.text || String(source);
            const p = sources.createEl("p");
            const pathPart = label.split("·")[0].trim();
            const link = p.createEl("a", { text: label, cls: "manex-source-link" });
            link.addEventListener("click", (e) => {
              e.preventDefault();
              this.app.workspace.openLinkText(pathPart.replace(/\.md$/, ""), "", false);
            });
          }
        }
      }
    }

    // form is outside the scroll area so it stays pinned to the bottom
    const form = container.createDiv({ cls: "manex-chat-form" });
    const input = form.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder: this.busy ? "Thinking…" : this.context ? "Ask about this note… (⌘↵ to send)" : "Add a note, then ask…"
      }
    });
    const askButton = form.createEl("button", {
      text: this.busy ? "Thinking…" : "Ask",
      cls: "mod-cta"
    });
    askButton.disabled = this.busy;
    askButton.addEventListener("click", () => {
      const q = input.value;
      input.value = "";
      this.ask(q);
    });
    input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        const q = input.value;
        input.value = "";
        this.ask(q);
      }
    });
  }

  getDisplayMessageGroups() {
    const groups = [];
    for (let index = 0; index < this.messages.length; index += 1) {
      const current = this.messages[index];
      const next = this.messages[index + 1];
      if (current?.role === "user" && next?.role === "assistant") {
        groups.push([next, current]);
        index += 1;
      } else {
        groups.push([current]);
      }
    }
    return groups.reverse();
  }
}

class MemoryModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Save study memory" });
    let title = this.options.defaultTitle;
    let type = this.options.defaultType || "correction";
    let text = this.options.defaultText;
    new Setting(contentEl).setName("Title").addText((input) => input.setValue(title).onChange((value) => { title = value; }));
    new Setting(contentEl).setName("Memory type").addDropdown((dropdown) => dropdown
      .addOption("correction", "Correction")
      .addOption("decision", "Decision")
      .addOption("answer", "Accepted answer")
      .addOption("note", "Study note")
      .setValue(type)
      .onChange((value) => { type = value; }));
    new Setting(contentEl).setName("Memory text").addTextArea((area) => {
      area.inputEl.rows = 8;
      area.inputEl.addClass("manex-memory-textarea");
      area.setValue(text);
      area.onChange((value) => { text = value; });
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Save memory").setCta().onClick(async () => {
        await this.options.onSubmit({ title, type, text });
        this.close();
      }))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }
}

class ManexStudyRoomSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Manex Brain" });

    new Setting(containerEl)
      .setName("Include frontmatter")
      .setDesc("Include YAML frontmatter when reading notes.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeFrontmatter || false)
        .onChange(async (value) => {
          this.plugin.settings.includeFrontmatter = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Support Manex Brain")
      .setDesc("Visit manex.app to learn more or support development.")
      .addButton((button) => button
        .setButtonText("Open manex.app")
        .onClick(() => window.open("https://manex.app", "_blank")));
  }
}

async function encodePayload(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === "function") {
    try {
      const compressed = await gzipBytes(bytes);
      return `gz.${base64UrlFromBytes(compressed)}`;
    } catch (error) {
      console.warn("Study Room import compression failed; using plain payload.", error);
    }
  }
  return `b64.${base64UrlFromBytes(bytes)}`;
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64UrlFromBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildClipboardPackage(payload) {
  return [`# ${payload.title}`, "", `Source: ${payload.sourcePath}`, "Shared from Obsidian via Study Room.", "", payload.body].join("\n");
}

function buildSystemPrompt(context, relevantChunks, localBrain, vaultChunks = []) {
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    "You are a personal knowledge assistant for an Obsidian vault. Answer questions using the note content provided.",
    "",
    `Today's date: ${today}`,
    "",
    "Important rules:",
    "- These notes may contain Dataview queries, templates, or code blocks. Do NOT reproduce query syntax. Interpret what the query is designed to show and answer in plain language.",
    "- When notes reference tasks with due dates, treat relative expressions like date(today) as referring to today's actual date above.",
    "- Refer to notes by their title, not their file path.",
    "- Answer in clear markdown. Be direct and specific.",
    "",
    `## Active note: ${context.title}`,
    `Path: ${context.sourcePath}`,
    "",
    "## Relevant sections from active note",
    ""
  ];

  if (relevantChunks.length) {
    for (const [i, chunk] of relevantChunks.entries()) {
      parts.push(`[Section ${i + 1}]`);
      parts.push(chunk.text);
      parts.push("");
    }
  } else {
    parts.push(truncateText(context.body, ANSWER_CONTEXT_CHAR_LIMIT));
    parts.push("");
  }

  if (vaultChunks.length) {
    parts.push("## Related vault notes");
    for (const chunk of vaultChunks) {
      parts.push(`[${chunk.title} — ${chunk.sourcePath}]`);
      parts.push(chunk.text);
      parts.push("");
    }
  }

  if (localBrain.length) {
    parts.push("## Prior study brain");
    for (const memory of localBrain) {
      const label = memory.type === "correction" ? "Correction" : memory.type === "decision" ? "Decision" : "Memory";
      parts.push(`- [${label}] ${memory.text}`);
    }
    parts.push("");
  }

  parts.push("Answer in plain markdown. Never reproduce Dataview queries or template syntax — interpret them. Cite the note title when referencing specific information.");

  return parts.join("\n");
}

function cosineScore(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function chunkText(text, size) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks = [];
  for (let i = 0; i < normalized.length; i += size) {
    chunks.push(normalized.slice(i, i + size).trim());
  }
  return chunks;
}

function scoreText(question, text) {
  const queryTokens = new Set(tokenize(question));
  const tokens = tokenize(text);
  if (!queryTokens.size || !tokens.length) return 0;
  let score = 0;
  for (const token of tokens) {
    if (queryTokens.has(token)) score += token.length > 5 ? 2 : 1;
  }
  return score;
}

function tokenize(text) {
  const stop = new Set(["about", "after", "again", "also", "and", "are", "because", "but", "can", "could", "does", "from", "have", "how", "into", "not", "the", "this", "that", "was", "what", "when", "where", "which", "with", "would", "your"]);
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{2,}/g)
    ?.filter((token) => !stop.has(token)) || [];
}

function classifyStudyTurn(text) {
  const value = normalizeWhitespace(text).toLowerCase();
  if (!value) return "comment";
  const correctionPatterns = [
    /\b(no|wrong|incorrect|actually|correction|correct that|not true|that's not|that is not)\b/,
    /\bremember that\b/,
    /\bnote that\b/,
    /\bwe decided\b/,
    /\bthe answer should\b/
  ];
  if (correctionPatterns.some((pattern) => pattern.test(value))) return "correction";
  if (/[?？]\s*$/.test(value)) return "question";
  if (/^(what|why|how|when|where|who|which|can|could|does|do|did|is|are|was|were|should|would)\b/.test(value)) return "question";
  return "comment";
}

function scoreLocalBrainMemory(query, memory) {
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) return 0;
  const weightedText = [
    memory.type === "correction" ? `${memory.text} ${memory.text}` : memory.text,
    memory.question,
    memory.answer,
    memory.title,
    memory.sourcePath,
    ...(Array.isArray(memory.sources) ? memory.sources : [])
  ].filter(Boolean).join(" ");
  let score = 0;
  for (const token of tokenize(weightedText)) {
    if (queryTokens.has(token)) score += token.length > 5 ? 2 : 1;
  }
  if (memory.type === "correction") score += 4;
  if (memory.type === "decision") score += 3;
  return score;
}

function normalizeAnswer(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/\s+(##\s+(Short answer|Evidence|What to remember))/gi, "\n\n$1")
    .replace(/\s+-\s+(\[(?:Brain|Note)\s+\d+\])/g, "\n- $1")
    .trim();
}

function stripFrontmatter(content) {
  return String(content || "").replace(/^---\s*[\s\S]*?\s*---\s*/m, "");
}

async function ensureFolder(app, folderPath) {
  if (app.vault.getAbstractFileByPath(folderPath)) return;
  await app.vault.createFolder(folderPath);
}

async function uniquePath(app, path) {
  if (!app.vault.getAbstractFileByPath(path)) return path;
  const dot = path.lastIndexOf(".");
  const base = dot >= 0 ? path.slice(0, dot) : path;
  const ext = dot >= 0 ? path.slice(dot) : "";
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}${ext}`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

function sanitizeFileName(value) {
  return String(value || "Study memory")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Study memory";
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function truncateText(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

module.exports = ManexStudyRoomPlugin;
