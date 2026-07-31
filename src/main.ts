import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { AskModal } from "./AskModal";
import { ChatView, VIEW_TYPE_CHAT, type PaneWhere } from "./ChatView";
import { HomeView, VIEW_TYPE_HOME } from "./HomeView";
import type { ConvState } from "./Conversation";
import { RewriteModal } from "./RewriteModal";
import { KnowledgeAiSettingTab } from "./SettingTab";
import { DEFAULT_SETTINGS, type KnowledgeAiSettings } from "./settings";
import { getUiLang, setUiLang, t } from "./i18n";
import { Embedder } from "./embedder";
import { embedBase } from "./models";
import { IndexStore } from "./index/store";
import { Indexer, isIgnored, type Progress } from "./index/indexer";

export default class KnowledgeAiPlugin extends Plugin {
  settings: KnowledgeAiSettings = DEFAULT_SETTINGS;
  store!: IndexStore;
  indexer: Indexer | null = null;
  private ribbonEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    setUiLang(this.settings.uiLang);

    this.store = new IndexStore(this.app.vault.getName(), this.settings.indexDir);
    await this.store.load();

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerView(VIEW_TYPE_HOME, (leaf) => new HomeView(leaf, this));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.hijackNewTab()));

    // 刻意不设默认快捷键。官方插件指南明确建议 avoid setting default hotkeys——
    // 常用组合早被别的插件占了，撞键的排查成本比省下的一次设置高得多。
    // 入口仍有三个：ribbon 图标、命令面板、用户自己绑的快捷键。
    this.addCommand({
      id: "ask",
      name: t("cmd.ask"),
      callback: () => this.openAsk(),
    });

    this.addCommand({
      id: "ask-selection",
      name: t("cmd.askSelection"),
      editorCallback: (editor) => {
        const sel = editor.getSelection().trim();
        this.openAsk(sel || undefined);
      },
    });

    this.addCommand({
      id: "rewrite-selection",
      name: t("cmd.rewrite"),
      editorCheckCallback: (checking, editor) => {
        const sel = editor.getSelection().trim();
        if (!sel) return false;
        if (!checking) new RewriteModal(this.app, this, editor, sel).open();
        return true;
      },
    });

    this.addCommand({
      id: "open-pane",
      name: t("cmd.openPane"),
      callback: () => void this.openChatPane(undefined, "right"),
    });

    this.addCommand({
      id: "open-home",
      name: t("cmd.openHome"),
      callback: () => void this.openHome(),
    });

    this.addCommand({
      id: "open-pane-center",
      name: t("cmd.openPaneCenter"),
      callback: () => void this.openChatPane(undefined, "center"),
    });

    // 右键菜单里也放一个，选中之后不用记命令名
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const sel = editor.getSelection().trim();
        if (!sel) return;
        menu.addItem((item) =>
          item
            .setTitle(t("cmd.rewrite"))
            .setIcon("wand")
            .onClick(() => new RewriteModal(this.app, this, editor, sel).open())
        );
      })
    );

    this.registerVaultWatchers();
    this.refreshRibbon();
    this.statusEl = this.addStatusBarItem();
    this.statusEl.hide();

    this.addSettingTab(new KnowledgeAiSettingTab(this.app, this));
  }

  onunload() {
    this.ribbonEl?.remove();
    this.indexer?.abort();
  }

  /** 库里文件增删改后自动增量更新索引。
   *  防抖 15 秒：modify 事件在编辑时会连续触发，每次都跑索引既浪费也吵。
   *  真正的开销由 mtime 增量兜住——没变的文件一次嵌入都不会发。 */
  private registerVaultWatchers(): void {
    const kick = debounce(() => {
      if (!this.settings.autoIndex) return;
      if (this.indexer?.running) return;
      void this.buildIndex(true);
    }, 15000, true);

    const relevant = (f: TAbstractFile) =>
      f instanceof TFile &&
      (f.extension === "md" ||
        (this.settings.includePdf && f.extension.toLowerCase() === "pdf")) &&
      // 忽略目录里的改动不该触发重建：那些文件本来就不进索引，
      // 每存一次盘白跑一轮增量扫描
      !isIgnored(f.path, this.settings.ignoreFolders);

    // 四个事件的回调签名不同，分开注册比循环更直白
    this.registerEvent(this.app.vault.on("create", (f) => { if (relevant(f)) kick(); }));
    this.registerEvent(this.app.vault.on("modify", (f) => { if (relevant(f)) kick(); }));
    this.registerEvent(this.app.vault.on("delete", (f) => { if (relevant(f)) kick(); }));
    this.registerEvent(this.app.vault.on("rename", (f) => { if (relevant(f)) kick(); }));
  }

  openAsk(prefill?: string) {
    new AskModal(this.app, this, prefill, this.imagesInActiveNote()).open();
  }

  /** 在当前标签页显示主页 */
  async openHome() {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_HOME, active: true });
  }

  /**
   * 接管新标签页。Beautitab 用的也是这个办法：layout-change 时看看
   * 最近的 leaf 是不是空的，是就换成自己的 view。
   *
   * 默认关闭。空标签页是「先到先得」的：同时装了 Beautitab、Home tab
   * 这类插件时，两边都会去改同一个 leaf，谁后跑谁赢，用户看到的是闪一下
   * 再被顶掉。让用户显式选一个，比默默打架好。
   */
  private hijackNewTab(): void {
    if (!this.settings.newTabHome) return;
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (leaf?.getViewState().type !== "empty") return;
    void leaf.setViewState({ type: VIEW_TYPE_HOME });
  }

  /**
   * 打开面板。同一个位置已经开着就复用那个 leaf，不会开出第二个——
   * 面板是常驻的，重复打开只会让人分不清哪个是当前对话。
   * 右侧和中间各自独立，两边可以同时开着不同的对话。
   */
  async openChatPane(state?: ConvState, where: PaneWhere = "right") {
    const { workspace } = this.app;
    const isCenter = (l: WorkspaceLeaf) => l.getRoot() === workspace.rootSplit;

    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(VIEW_TYPE_CHAT)
        .find((l) => isCenter(l) === (where === "center")) ?? null;

    if (!leaf) {
      leaf = where === "center" ? workspace.getLeaf("tab") : workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    await workspace.revealLeaf(leaf);

    // Obsidian 1.7 起，侧边栏里没被聚焦过的 leaf 是「延迟视图」：
    // leaf.view 返回的是占位对象而不是 ChatView，直接 as 转型再调 adopt
    // 会抛错或调到空壳——从弹窗搬过来的会话就这么丢了。
    // 必须先 loadIfDeferred() 把它实例化，再用 instanceof 确认。
    if (leaf.isDeferred) await leaf.loadIfDeferred();

    const view = leaf.view;
    if (state && view instanceof ChatView) view.adopt(state);
  }

  /**
   * 当前 PDF 翻到第几页。不是 PDF、或者读不出来就返回 null。
   *
   * 用公开的 leaf.getViewState()——Obsidian 的 PDF 视图把页码存在 state.page 里
   * （workspace.json 里就是 {"file":"x.pdf","page":12,"left":…,"zoom":…}），
   * 滚动时会同步更新。不要去挖 view.viewer.child.pdfViewer.currentPageNumber，
   * 那条路径在当前版本上根本不存在，试过，永远返回 undefined。
   */
  contextPage(): number | null {
    const f = this.contextFile();
    if (!f || f.extension.toLowerCase() !== "pdf") return null;
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      const st = leaf.getViewState().state as { file?: string; page?: number } | undefined;
      if (st?.file !== f.path) continue;
      return typeof st.page === "number" && st.page > 0 ? st.page : null;
    }
    return null;
  }

  /**
   * 提问时「这篇/这个/本文」指的是哪个文件。
   *
   * 侧边栏面板拿到焦点后 getActiveFile() 仍然返回上一个正文文件，所以直接用它；
   * 但面板开在中间标签页时它会变成面板自己，那种情况返回 null，退回全库检索。
   */
  contextFile(): TFile | null {
    const f = this.app.workspace.getActiveFile();
    if (!f) return null;
    const ext = f.extension.toLowerCase();
    return ext === "md" || ext === "pdf" ? f : null;
  }

  /** 当前笔记里内嵌的本地图片。弹窗里列出来供一键附带——
   *  不自动附上：一篇文章可能有十几张图，全发过去既慢又吵。 */
  imagesInActiveNote(): TFile[] {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return [];
    const cache = this.app.metadataCache.getFileCache(file);
    const links = [...(cache?.embeds ?? []), ...(cache?.links ?? [])];
    const out: TFile[] = [];
    for (const l of links) {
      const target = this.app.metadataCache.getFirstLinkpathDest(l.link, file.path);
      if (target && /^(png|jpe?g|webp|gif)$/i.test(target.extension) &&
          !out.some((x) => x.path === target.path)) {
        out.push(target);
      }
    }
    return out.slice(0, 12);
  }

  /** ribbon 图标可在设置里开关，改完立即生效 */
  refreshRibbon() {
    this.ribbonEl?.remove();
    this.ribbonEl = null;
    if (!this.settings.showRibbon) return;
    this.ribbonEl = this.addRibbonIcon("search", t("plugin.name"), () => this.openAsk());
  }

  /** 状态栏进度：索引时显示，空闲时隐藏 */
  setStatusText(text: string | null) {
    if (!this.statusEl) return;
    if (text === null) {
      this.statusEl.hide();
    } else {
      this.statusEl.show();
      this.statusEl.setText(text);
    }
  }

  /** 建/更新索引。已在跑就忽略，避免并发写同一个库。
   *  silent=true 用于自动触发：只走状态栏，不弹通知打扰用户。 */
  async buildIndex(silent = false): Promise<void> {
    // 自动索引（防抖 15 秒）随时可能在跑。手动点按钮撞上它时必须说一声——
    // 静默 return 的话按钮禁用又立刻恢复，看起来就是「点了没反应」。
    if (this.indexer?.running) {
      if (!silent) this.notify(t("index.busy"));
      return;
    }
    const emb = new Embedder(embedBase(this.settings), this.settings.embedModel, this.settings.apiKey);
    this.indexer = new Indexer(this.app.vault, this.store, emb, this.settings);
    try {
      const r = await this.indexer.run(this.settings.scopeFolders, (p: Progress) =>
        this.setStatusText(
          t("index.building", { done: p.done, total: p.total }) +
            (p.current ? ` · ${p.current.slice(0, 28)}` : "")
        )
      );
      this.setStatusText(null);
      // 自动触发且什么都没变时保持安静，否则每次保存笔记都弹一次通知
      if (silent && r.files === 0 && r.removed === 0) return;
      this.notify(
        t("index.done", {
          chunks: this.store.size,
          files: this.store.fileCount,
          seconds: r.seconds.toFixed(0),
        }) + (r.failed.length ? `\n${t("index.failed", { n: r.failed.length })}` : "")
      );
      if (r.failed.length) console.warn("[knowledge-ai] 提取失败:", r.failed);
    } catch (e) {
      this.setStatusText(null);
      this.notify(t("error.generic", { message: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** 彻底重建：换嵌入模型或索引损坏时用。会清空后全量重跑。 */
  async rebuildIndex(): Promise<void> {
    if (this.indexer?.running) return;
    this.store.reset();
    await this.store.save();
    await this.buildIndex();
  }

  /** 库内图片数量，用于在设置里估算描述耗时 */
  imageCount(): number {
    return this.app.vault.getFiles().filter((f) =>
      /^(png|jpe?g|webp|gif)$/i.test(f.extension) &&
      !isIgnored(f.path, this.settings.ignoreFolders)).length;
  }

  /** 当前被忽略规则挡住的 md/pdf 数量，用于在设置页给出即时反馈 */
  ignoredCount(): number {
    return this.app.vault.getFiles().filter((f) =>
      /^(md|pdf)$/i.test(f.extension) &&
      isIgnored(f.path, this.settings.ignoreFolders)).length;
  }

  /**
   * 把已经进过索引、但现在落在忽略目录里的块立刻删掉。
   *
   * 不能等下一次索引再顺带清理——改完设置的人期望的是「马上搜不到」，
   * 而增量索引可能几小时后才被触发，这中间提问仍会召回它们。
   */
  async purgeIgnored(): Promise<number> {
    const gone = new Set<string>();
    for (const p of this.store.indexedPaths()) {
      if (isIgnored(p, this.settings.ignoreFolders)) gone.add(p);
    }
    if (gone.size === 0) return 0;
    this.store.removePaths(gone);
    await this.store.save();
    return gone.size;
  }

  /** PDF 提取文本的缓存目录，和索引放在一起 */
  pdfCacheDir(): string {
    return require("path").join(this.store.location, "pdftext");
  }

  /** 粗估整库能切出多少块，用于「嵌入 Test」里换算索引耗时 */
  estimatedChunks(): number {
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => !isIgnored(f.path, this.settings.ignoreFolders));
    const bytes = files.reduce((a, f) => a + f.stat.size, 0);
    return Math.max(1, Math.round(bytes / 1050));
  }

  indexSummary(): string {
    if (this.store.size === 0) return t("modal.statsEmpty");
    const { notes, pdfs } = this.store.fileBreakdown();
    return t("modal.stats", { notes, pdfs, chunks: this.store.size });
  }

  /** M3 之后换成基于用户实际笔记生成 */
  exampleQuestions(): string[] {
    return [
      getUiLang() === "en"
        ? "What have I written about deep work?"
        : "我记过哪些关于深度工作的方法",
    ];
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.migrate();
  }

  /** 清掉早期方案遗留的配置。
   *  嵌入一度打算用 transformers.js 在插件内跑，默认值是 HuggingFace 的
   *  仓库名（Xenova/…）；改成走端点之后那种名字在 Ollama 上必然找不到，
   *  留着只会让用户看到一句莫名其妙的 "model not found"。 */
  private migrate(): void {
    if (/^Xenova\//i.test(this.settings.embedModel)) {
      this.settings.embedModel = DEFAULT_SETTINGS.embedModel;
      void this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    setUiLang(this.settings.uiLang);
  }

  notify(msg: string) {
    new Notice(msg);
  }
}
