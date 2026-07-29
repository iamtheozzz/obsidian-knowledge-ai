import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { t } from "./i18n";
import type KnowledgeAiPlugin from "./main";

export const VIEW_TYPE_HOME = "knowledge-ai-home";

/** 最近打开的笔记显示几条 */
const RECENT_N = 6;

/**
 * 新标签页主页。布局照搜索引擎首页那套：大留白、居中一个搜索框、
 * 下面挂几条快捷入口。
 *
 * 搜索框是个 div 而不是真 input——点一下就把已有的 AskModal 唤起来。
 * 做成真输入框会有两个焦点、两处历史、两套图片粘贴逻辑要同步，
 * 而弹窗本来就是主入口，没必要在这里再实现一遍。
 */
export class HomeView extends ItemView {
  private plugin: KnowledgeAiPlugin;
  private root!: HTMLElement;
  private actionEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: KnowledgeAiPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_HOME;
  }

  getDisplayText() {
    return t("home.tab");
  }

  getIcon() {
    return "wand-sparkles";   // sparkles 不在 Obsidian 的图标集里，会渲染成空白
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    this.root = root;
    root.empty();
    root.addClass("kai-home");

    const inner = root.createDiv({ cls: "kai-home-inner" });
    inner.createDiv({ cls: "kai-home-title", text: t("brand") });

    // ── 搜索框（点击 → 弹窗）─────────────────────────
    const box = inner.createDiv({ cls: "kai-home-search" });
    setIcon(box.createSpan({ cls: "kai-home-search-icon" }), "search");
    box.createSpan({ cls: "kai-home-search-ph", text: t("modal.placeholder") });
    box.addEventListener("click", () => this.plugin.openAsk());

    // 直接敲字也能进——和搜索引擎首页一样，不必先点框。
    // 用 tabindex 让容器可聚焦，比挂全局监听干净：面板失焦后自然不再拦键盘。
    root.tabIndex = -1;
    root.addEventListener("keydown", (e) => {
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      this.plugin.openAsk(e.key);
    });
    window.setTimeout(() => root.focus(), 0);

    inner.createDiv({ cls: "kai-home-stats", text: this.plugin.indexSummary() });

    // ── 示例问题 ─────────────────────────────────────
    const ex = inner.createDiv({ cls: "kai-home-chips" });
    for (const q of this.plugin.exampleQuestions()) {
      const chip = ex.createDiv({ cls: "kai-home-chip", text: q });
      chip.addEventListener("click", () => this.plugin.openAsk(q));
    }

    // ── 最近笔记 ─────────────────────────────────────
    const recent = this.recentFiles();
    if (recent.length) {
      const box2 = inner.createDiv({ cls: "kai-home-recent" });
      box2.createDiv({ cls: "kai-home-section", text: t("home.recent") });
      for (const f of recent) {
        const row = box2.createDiv({ cls: "kai-home-file" });
        setIcon(row.createSpan({ cls: "kai-home-file-icon" }), "file-text");
        row.createSpan({ text: f.basename });
        row.addEventListener("click", () => void this.app.workspace.openLinkText(f.path, "", false));
      }
    }

    // 简洁模式按钮放标题栏，不放页面里——页面里多一个按钮，
    // 恰恰是简洁模式想去掉的那种东西
    this.actionEl = this.addAction("minimize-2", t("home.minimal"), () => void this.toggleMinimal());
    this.applyMinimal();
  }

  /** 只留标题和搜索框，其余全部隐藏 */
  applyMinimal() {
    const on = this.plugin.settings.homeMinimal;
    this.root.toggleClass("kai-home-minimal", on);
    setIcon(this.actionEl, on ? "maximize-2" : "minimize-2");
    this.actionEl.setAttribute("aria-label", t(on ? "home.full" : "home.minimal"));
  }

  private async toggleMinimal() {
    this.plugin.settings.homeMinimal = !this.plugin.settings.homeMinimal;
    await this.plugin.saveSettings();
    // 可能同时开着好几个主页标签，一起切，否则看着像没生效
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HOME)) {
      (leaf.view as HomeView).applyMinimal?.();
    }
  }

  async onClose() {
    this.containerEl.children[1]?.empty();
  }

  /** 走 Obsidian 自己的最近文件记录，和 Quick Switcher 的顺序一致 */
  private recentFiles(): TFile[] {
    const paths: string[] = this.app.workspace.getLastOpenFiles() ?? [];
    const out: TFile[] = [];
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile && f.extension === "md") out.push(f);
      if (out.length >= RECENT_N) break;
    }
    return out;
  }
}
