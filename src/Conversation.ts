import { App, Component, MarkdownRenderer, MarkdownView, Notice, TFile, setIcon } from "obsidian";
import { LocalBackend } from "./backend/local";
import type { AskEvent, Source, Turn } from "./backend/types";
import { t } from "./i18n";
import { isAboutCurrentFile, isAboutCurrentPage } from "./prompts";
import { FileSuggest } from "./FileSuggest";
import type KnowledgeAiPlugin from "./main";

/**
 * 一轮问答的完整记录。比 Turn 多带 sources 和图片数——
 * 从弹窗搬到面板时要能原样重画，光有文本不够。
 */
export interface TurnRecord {
  question: string;
  answer: string;
  sources: Source[];
  images: number;
}

/** 可搬运的会话状态。弹窗 →「在面板中打开」时整包传过去。 */
export interface ConvState {
  turns: TurnRecord[];
  draft: string;
}

export interface ConvHost {
  /** 点开引用、插入笔记之后要不要收起容器。弹窗收，面板不收。 */
  dismiss(): void;
  /** 提供了才显示「在面板中打开」。面板自己当然不显示。 */
  detach?: (state: ConvState) => void;
}

/**
 * 对话主体：输入框、消息流、检索、流式渲染、引用、操作按钮。
 *
 * 从 AskModal 抽出来，因为右侧面板要的是同一套东西。两边只差外壳：
 * 弹窗是居中浮层、点引用就关掉；面板常驻、点引用留着。差异全部收在
 * ConvHost 里，渲染和主流程一份代码。
 */
export class Conversation {
  readonly app: App;
  private plugin: KnowledgeAiPlugin;
  private host: ConvHost;

  private root!: HTMLElement;
  private inputWrap!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private chipsEl!: HTMLDivElement;
  private scrollEl!: HTMLDivElement;

  private history: Turn[] = [];
  private records: TurnRecord[] = [];
  /** 本轮附带的图片，data URL。发出后清空。 */
  private pending: { name: string; url: string }[] = [];
  private controller: AbortController | null = null;

  private noteImages: TFile[] = [];
  /** markdown 渲染用的宿主组件。生命周期跟着这次会话，不是跟着插件。 */
  private readonly component = new Component();
  /** 空状态是否用主页那套居中大标题的样子。面板用，弹窗不用。 */
  private homeStyle = false;
  /** 用户手选的检索范围。空表示全库。 */
  private picked: TFile[] = [];
  private filesEl?: HTMLDivElement;
  private resetEl?: HTMLElement;
  private scopeEl?: HTMLElement;

  constructor(app: App, plugin: KnowledgeAiPlugin, host: ConvHost) {
    // 必须 load，否则 MarkdownRenderer 挂上来的子组件不会被激活
    this.component.load();
    this.app = app;
    this.plugin = plugin;
    this.host = host;
  }

  // ── 生命周期 ──────────────────────────────────────────

  /**
   * 建 DOM。inputAtTop 决定初始布局：
   * 弹窗首问时输入框在顶部（像 Quick Switcher），出答案后落到底部；
   * 面板是常驻对话，一开始就在底部。
   */
  mount(
    root: HTMLElement,
    opts: {
      inputAtTop: boolean;
      dropTarget?: HTMLElement;
      pickFiles?: boolean;
      homeStyle?: boolean;
    } = { inputAtTop: true }
  ) {
    this.root = root;
    this.homeStyle = Boolean(opts.homeStyle);
    root.empty();

    this.inputWrap = createDiv({ cls: "kai-input-wrap" });
    // 弹窗没有文件选择那一套，但只要开了「快捷检索开关」，它也该有这个按钮——
    // 用户是在任何一个输入框前决定这一问要不要走库内检索的。
    if (opts.pickFiles || this.plugin.settings.quickScope) {
      // 一排工具条：左边是「＋」和已选文件胶囊，右边是开关和清空。
      // 左右两组必须在同一个 flex 行里对齐——右边那两个按钮曾经是
      // absolute 定位的，输入区一改 padding 就和「＋」错开半格。
      const bar = this.inputWrap.createDiv({ cls: "kai-toolbar" });
      const left = bar.createDiv({ cls: "kai-files" });
      if (opts.pickFiles) {
        this.filesEl = left;
        const add = left.createDiv({ cls: "kai-file-add" });
        setIcon(add.createSpan(), "plus");
        add.setAttribute("aria-label", t("files.pick"));
        add.addEventListener("click", () => this.pickFile());
      }

      const right = bar.createDiv({ cls: "kai-tool-right" });

      // 库内检索开关。和设置页里那个是同一个 settings.vaultRetrieval，
      // 任一边改了都立刻存盘并推给另一边（saveSettings → refreshScopeToggles）。
      const scope = right.createDiv({ cls: "kai-file-add kai-scope" });
      // 图标名必须用 Obsidian 真正打进包里的那批 lucide——名字不存在时
      // setIcon 不报错，只是什么都不画，按钮会变成一个空方块。
      // 实测 obsidian.asar 里有 lucide-library，没有 lucide-library-big。
      setIcon(scope.createSpan(), "library");
      scope.addEventListener("click", () => void this.toggleScope());
      this.scopeEl = scope;
      this.syncScope();

      if (opts.pickFiles) {
        // 清空对话也放这儿。视图标题栏那个 addAction 在侧边栏里很容易被
        // 忽略甚至不显示，放进输入区旁边才是稳的。
        const clear = right.createDiv({ cls: "kai-file-add kai-reset" });
        setIcon(clear.createSpan(), "rotate-ccw");
        clear.setAttribute("aria-label", t("pane.reset"));
        clear.addEventListener("click", () => this.reset());
        this.resetEl = clear;

        this.renderFiles();
      }
    }
    this.inputEl = this.inputWrap.createEl("textarea", {
      cls: "kai-input",
      attr: { rows: "1", placeholder: t("modal.placeholder") },
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("keydown", (e) => this.onKey(e));
    this.inputEl.addEventListener("paste", (e) => this.onPaste(e));
    this.chipsEl = this.inputWrap.createDiv({ cls: "kai-chips" });

    this.scrollEl = createDiv({ cls: "kai-body" });

    if (opts.inputAtTop) {
      root.appendChild(this.inputWrap);
      root.appendChild(this.scrollEl);
    } else {
      root.appendChild(this.scrollEl);
      root.appendChild(this.inputWrap);
    }

    // 整个容器都接受拖入，不用精确拖到输入框上
    const drop = opts.dropTarget ?? root;
    drop.addEventListener("dragover", (e) => e.preventDefault());
    drop.addEventListener("drop", (e) => this.onDrop(e));

    this.renderEmpty();
  }

  destroy() {
    this.controller?.abort();
    this.controller = null;
    this.component.unload();
  }

  /**
   * 清空对话，从头开始。
   *
   * 保留已选的文件范围——那是「在哪儿找」的设置，不是对话内容。
   * 正在读一篇长文档时开新话题，不该顺手把范围也清掉；
   * 真要清，胶囊上的 × 就在输入框上面。
   */
  reset() {
    this.controller?.abort();
    this.controller = null;
    this.history = [];
    this.records = [];
    this.pending = [];
    this.renderChips();
    this.inputEl.value = "";
    this.autoGrow();
    this.inputEl.setAttribute("placeholder", t("modal.placeholder"));
    this.renderEmpty();
    this.focus();
  }

  focus() {
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  setDraft(text: string) {
    this.inputEl.value = text;
    this.autoGrow();
  }

  setNoteImages(files: TFile[]) {
    this.noteImages = files;
    if (this.records.length === 0) this.renderEmpty();
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  // ── 状态搬运 ──────────────────────────────────────────

  state(): ConvState {
    return { turns: [...this.records], draft: this.inputEl.value };
  }

  /**
   * 用既有记录重建界面。不重新调模型——答案是现成的，
   * 直接按 done 之后的样子画一遍就行。
   */
  restore(s: ConvState) {
    this.records = [...s.turns];
    this.history = [];
    for (const r of this.records) {
      this.history.push({ role: "user", content: r.question });
      this.history.push({ role: "assistant", content: r.answer });
    }

    if (this.records.length === 0) {
      this.renderEmpty();
    } else {
      this.scrollEl.empty();
      for (const r of this.records) this.replay(r);
      this.inputEl.setAttribute("placeholder", t("modal.placeholderFollowUp"));
      this.toBottomLayout();
    }
    this.setDraft(s.draft);
  }

  private replay(r: TurnRecord) {
    const turn = this.scrollEl.createDiv({ cls: "kai-turn" });
    turn.createDiv({ cls: "kai-question", text: r.question });
    if (r.images) {
      turn.createDiv({ cls: "kai-question-imgs", text: t("modal.imgAttached", { n: r.images }) });
    }
    const answerEl = turn.createDiv({ cls: "kai-answer" });
    this.finishAnswer(answerEl, r.answer, r.sources, turn);
  }

  // ── 交互 ──────────────────────────────────────────────

  private autoGrow() {
    // 高度必须运行时算（要读 scrollHeight），但不能直接写 .style——
    // 官方 lint 规则 no-static-styles-assignment 会报错，要走 setCssStyles。
    this.inputEl.setCssStyles({ height: "auto" });
    this.inputEl.setCssStyles({
      height: `${Math.min(this.inputEl.scrollHeight, 160)}px`,
    });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const q = this.inputEl.value.trim();
      if (q && !this.controller) void this.ask(q);
      return;
    }
    // 生成中按 Esc 先中止，不关窗——答到一半想停下是常见需求
    if (e.key === "Escape" && this.controller) {
      e.preventDefault();
      e.stopPropagation();
      this.controller.abort();
    }
  }

  /** 粘贴板里的图片直接收下——截图后 Cmd+V 是最顺手的路径 */
  private onPaste(e: ClipboardEvent) {
    const imgs = Array.from(e.clipboardData?.items ?? []).filter((i) =>
      i.type.startsWith("image/")
    );
    if (imgs.length === 0) return;
    e.preventDefault();
    for (const it of imgs) {
      const f = it.getAsFile();
      if (f) void this.attachFile(f);
    }
  }

  private onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) void this.attachFile(f);
  }

  private async attachFile(f: File) {
    const raw = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    this.pending.push({ name: f.name || "image", url: await downscale(raw) });
    this.renderChips();
  }

  /** 把库里的图片读成 data URL 并缩图，走和粘贴同一条路径 */
  private async attachVaultImage(f: TFile) {
    const buf = await this.app.vault.readBinary(f);
    const mime = f.extension.toLowerCase() === "png" ? "image/png" : "image/jpeg";
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    this.pending.push({ name: f.name, url: await downscale(`data:${mime};base64,${btoa(bin)}`) });
    this.renderChips();
  }

  private pickFile() {
    new FileSuggest(this.app, this.picked.map((f) => f.path), (f) => {
      this.picked.push(f);
      this.renderFiles();
      this.inputEl.focus();
    }).open();
  }

  /** 点一下换个状态，立刻存盘，再推给别处开着的面板和设置页。 */
  private async toggleScope() {
    this.plugin.settings.vaultRetrieval = !this.plugin.settings.vaultRetrieval;
    await this.plugin.saveSettings();
  }

  /**
   * 把按钮的样子对齐到当前设置。
   *
   * 状态只存在 settings 里，按钮自己不留一份——两处各存一份必然会漂：
   * 在设置页关掉再回到面板，按钮还亮着，而实际发出去的请求已经不 grounded 了。
   */
  syncScope() {
    if (!this.scopeEl) return;
    // 按钮始终建出来，显示与否只由 class 控制——这样在设置页里开关「快捷检索开关」
    // 时，已经开着的面板不用重建 DOM 就能立刻跟上。
    this.scopeEl.toggleClass("kai-hidden", !this.plugin.settings.quickScope);
    const on = this.plugin.settings.vaultRetrieval;
    this.scopeEl.toggleClass("is-on", on);
    this.scopeEl.setAttribute("aria-label", t(on ? "scope.on" : "scope.off"));
  }

  /** 已选文件的胶囊。加号按钮始终排在最后。 */
  private renderFiles() {
    if (!this.filesEl) return;
    const add = this.filesEl.querySelector(".kai-file-add");
    this.filesEl.empty();
    this.picked.forEach((f, i) => {
      const chip = this.filesEl!.createDiv({ cls: "kai-file-chip" });
      setIcon(chip.createSpan({ cls: "kai-file-icon" }), "file-text");
      chip.createSpan({ text: f.name });
      const x = chip.createSpan({ cls: "kai-chip-x", text: "×" });
      x.addEventListener("click", () => {
        this.picked.splice(i, 1);
        this.renderFiles();
      });
    });
    if (add) this.filesEl.appendChild(add);
  }

  private renderChips() {
    this.chipsEl.empty();
    this.pending.forEach((img, i) => {
      const chip = this.chipsEl.createDiv({ cls: "kai-chip" });
      chip.createEl("img", { cls: "kai-chip-thumb", attr: { src: img.url } });
      chip.createSpan({ text: img.name.slice(0, 20) });
      const x = chip.createSpan({ cls: "kai-chip-x", text: "×" });
      x.addEventListener("click", () => {
        this.pending.splice(i, 1);
        this.renderChips();
      });
    });
  }

  private renderEmpty() {
    this.scrollEl.empty();
    if (this.homeStyle) {
      this.renderEmptyHome();
      return;
    }
    this.scrollEl.createDiv({ cls: "kai-stats", text: this.plugin.indexSummary() });

    // 当前笔记里的图，点缩略图即可附带
    if (this.noteImages.length) {
      const box = this.scrollEl.createDiv({ cls: "kai-note-imgs" });
      box.createDiv({
        cls: "kai-examples-title",
        text: t("modal.noteImages", { n: this.noteImages.length }),
      });
      const row = box.createDiv({ cls: "kai-thumbs" });
      for (const f of this.noteImages) {
        const thumb = row.createEl("img", {
          cls: "kai-thumb",
          attr: { src: this.app.vault.getResourcePath(f), title: f.name },
        });
        thumb.addEventListener("click", () => void this.attachVaultImage(f));
      }
    }

    const ex = this.scrollEl.createDiv({ cls: "kai-examples" });
    ex.createDiv({ cls: "kai-examples-title", text: t("modal.examplesTitle") });
    for (const s of this.plugin.exampleQuestions()) {
      const item = ex.createDiv({ cls: "kai-example", text: s });
      item.addEventListener("click", () => void this.ask(s));
    }
  }

  /**
   * 面板的空状态：和新标签页主页同一套样子。
   *
   * 面板比弹窗高得多，沿用弹窗那种左上角贴一行统计的排版，
   * 下面会空出一大片，看着像没加载出来。
   */
  private renderEmptyHome() {
    const box = this.scrollEl.createDiv({ cls: "kai-empty-home" });
    box.createDiv({ cls: "kai-home-title", text: t("brand") });
    box.createDiv({ cls: "kai-home-stats", text: this.plugin.indexSummary() });

    if (this.noteImages.length) {
      const imgs = box.createDiv({ cls: "kai-note-imgs" });
      imgs.createDiv({
        cls: "kai-examples-title",
        text: t("modal.noteImages", { n: this.noteImages.length }),
      });
      const row = imgs.createDiv({ cls: "kai-thumbs" });
      for (const f of this.noteImages) {
        const thumb = row.createEl("img", {
          cls: "kai-thumb",
          attr: { src: this.app.vault.getResourcePath(f), title: f.name },
        });
        thumb.addEventListener("click", () => void this.attachVaultImage(f));
      }
    }

    const chips = box.createDiv({ cls: "kai-home-chips" });
    for (const q of this.plugin.exampleQuestions()) {
      const chip = chips.createDiv({ cls: "kai-home-chip", text: q });
      chip.addEventListener("click", () => void this.ask(q));
    }
  }

  private scrollToBottom() {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  /** 输入框落到底部，变成对话流 */
  private toBottomLayout() {
    this.root.appendChild(this.inputWrap);
  }

  // ── 主流程 ────────────────────────────────────────────

  async ask(question: string) {
    if (!this.plugin.settings.chatModel) {
      new Notice(t("error.noEndpoint"));
      return;
    }
    if (this.records.length === 0) this.scrollEl.empty();

    this.inputEl.value = "";
    this.autoGrow();
    this.inputEl.setAttribute("placeholder", t("modal.placeholderFollowUp"));
    this.toBottomLayout();

    const turn = this.scrollEl.createDiv({ cls: "kai-turn" });
    turn.createDiv({ cls: "kai-question", text: question });
    const statusEl = turn.createDiv({ cls: "kai-status" });
    const foundEl = turn.createDiv({ cls: "kai-found" });
    const answerEl = turn.createDiv({ cls: "kai-answer" });
    // 思考指示：从发出请求一直转到第一个字吐出来为止。
    // 本地模型首字要等 15–30 秒，没有这个反馈用户会以为卡死了。
    // 放在 answerEl 里而不是状态行，因为它标的就是「答案马上出现在这」。
    const thinking = answerEl.createDiv({ cls: "kai-thinking" });
    this.scrollToBottom();

    let foundCount = 0;
    let scopeNote = "";
    // 这一轮到底检索没检索。不去读设置来判断——那等于把后端的规则
    // 在界面上再抄一遍，两处早晚会不一致。后端发没发 found 就是答案。
    let searched = false;
    // 图片随本轮发出后就清空，避免下一问还挂着
    const images = this.pending.map((p) => p.url);
    this.pending = [];
    this.renderChips();
    if (images.length) {
      turn.createDiv({ cls: "kai-question-imgs", text: t("modal.imgAttached", { n: images.length }) });
    }

    // 「这篇论文讲了什么」——把检索限定到当前打开的文件。
    // 不做这一步的话，那句话里没有可检索的实词，会命中一堆无关的同类文档。
    // 手选的文件优先；没手选才看「这篇/这个」是不是在指当前打开的文件
    const ctxFile = this.picked.length === 0 && isAboutCurrentFile(question)
      ? this.plugin.contextFile()
      : null;
    const scope = this.picked.length
      ? this.picked.map((f) => f.path)
      : ctxFile
        ? [ctxFile.path]
        : undefined;
    // 「这页讲了什么」——比限定文件还窄一层：只取当前翻到的那一页，
    // 而且不走相似度，整页原样送进去。相似度在这里没有意义，
    // 用户要的就是"这一页"，不是"这一页里最像我问题的几段"。
    const pageNo = !this.picked.length && isAboutCurrentPage(question)
      ? this.plugin.contextPage()
      : null;
    const pageHits = ctxFile && pageNo ? this.plugin.store.pageOf(ctxFile.path, pageNo) : [];

    const scopeName = this.picked.length === 1
      ? this.picked[0].basename
      : this.picked.length > 1
        ? t("files.n", { n: this.picked.length })
        : ctxFile?.basename;
    if (pageHits.length && ctxFile) {
      statusEl.setText(t("status.scopedToPage", { name: ctxFile.basename, page: pageNo! }));
    } else if (scopeName) {
      statusEl.setText(t("status.scopedTo", { name: scopeName }));
    }

    this.controller = new AbortController();
    const backend = new LocalBackend(this.plugin.settings, this.plugin.store);
    let raw = "";

    const onEvent = (e: AskEvent) => {
      switch (e.type) {
        case "searching":
          statusEl.setText(t("status.searching"));
          break;

        case "found":
          searched = true;
          foundCount = e.hits.length;
          if (e.since) scopeNote = t("status.since", { range: e.since });
          // 先亮来源再开始生成：本地模型要等 15–30 秒，
          // 这段时间给用户可读的东西，也让他一眼看出检索对不对
          statusEl.setText(
            e.hits.length
              ? (scopeName
                  ? t("status.foundIn", { n: e.hits.length, name: scopeName })
                  : t("status.found", { n: e.hits.length })) + scopeNote
              : scopeName
                ? t("error.noResultsIn", { name: scopeName })
                : t("error.noResults")
          );
          for (const h of e.hits.slice(0, 5)) {
            const row = foundEl.createDiv({ cls: "kai-found-row" });
            row.createSpan({ cls: "kai-score", text: h.score.toFixed(2) });
            row.createSpan({
              text: `${h.path.split("/").pop()}  ${
                h.page ? t("answer.page", { page: h.page }) : `L${h.line}`
              }`,
            });
          }
          statusEl.setText(t("status.answering"));
          this.scrollToBottom();
          break;

        case "token":
          thinking.remove();              // 第一个字到了，动画退场
          raw += e.text;
          answerEl.setText(raw);          // 流式期间用纯文本，避免反复重排
          this.scrollToBottom();
          break;

        case "done": {
          // sources 现在按「文件+页」拆，篇数得去重算，不能直接用长度
          const fileCount = new Set(e.sources.map((x) => x.path)).size;
          // 压根没检索的那一轮，状态行整个撤掉——「库里没有找到相关内容」
          // 是检索过之后的结论，没检索却这么说是在撒谎。
          if (!searched) {
            statusEl.remove();
          } else {
            // 不要直接删掉状态行——召回列表收起来后只剩一行，
            // 看着像「只找到一条」。留一句摘要说明实际引用了多少。
            statusEl.addClass("kai-summary");
            statusEl.setText(
              e.sources.length
                ? e.usedChunks < foundCount
                  // 预算砍掉了一部分，说清楚，别让用户以为 8 段都读了
                  ? t("status.usedPartial", {
                      files: fileCount,
                      used: e.usedChunks,
                      n: foundCount,
                    })
                  : t("status.usedSources", { files: fileCount, n: foundCount })
                : t("error.noResults")
            );
          }
          foundEl.addClass("kai-found-collapsed");
          this.finishAnswer(answerEl, e.answer, e.sources, turn);
          this.history.push({ role: "user", content: question });
          this.history.push({ role: "assistant", content: e.answer });
          this.records.push({
            question,
            answer: e.answer,
            sources: e.sources,
            images: images.length,
          });
          this.controller = null;
          this.inputEl.focus();
          break;
        }

        case "error":
          thinking.remove();
          statusEl.remove();
          answerEl.addClass("kai-error");
          answerEl.setText(t("error.generic", { message: e.message }));
          this.controller = null;
          break;
      }
    };

    try {
      await backend.ask(
        {
          question,
          history: this.history,
          scope,
          // 手选文件时 picked 非空，那是明确意图；只有靠 ctxFile 猜出来的才算推断。
          //
          // 「这页」例外：它的指向足够明确，不该被当成猜测。
          // 说「这页」时若页码取不到（md 笔记没有页、或那页是扫描件提不出文字），
          // pageHits 会是空的，从而落到普通检索这条路上——这时正确的降级是
          // 「只在当前文件里找」，而不是退回全库。退回全库等于把用户
          // 明确划定的范围整个丢掉，比召回质量差更糟。
          scopeInferred:
            this.picked.length === 0 && Boolean(ctxFile) && !isAboutCurrentPage(question),
          pinned: pageHits.length ? pageHits : undefined,
          images: images.length ? images : undefined,
          signal: this.controller.signal,
        },
        onEvent
      );
    } finally {
      thinking.remove();                 // 中止或异常退出时别把点留在那转
      if (this.controller?.signal.aborted) {
        statusEl.setText(t("status.stopped"));
        this.controller = null;
      }
    }
  }

  /** 生成结束后：markdown 渲染 + 参考资料 + 操作按钮 */
  private finishAnswer(
    answerEl: HTMLElement,
    answer: string,
    sources: Source[],
    turn: HTMLElement
  ) {
    answerEl.empty();
    // 不要把 plugin 实例当 Component 传进去：它活到插件卸载为止，
    // 每渲染一次答案就往上挂一批子组件，永远不释放。用会话自己的
    // Component，destroy() 时一起卸掉。
    void MarkdownRenderer.render(this.app, answer, answerEl, "", this.component);

    if (sources.length) {
      const refs = turn.createDiv({ cls: "kai-refs" });
      refs.createDiv({ cls: "kai-refs-title", text: t("answer.references") });

      // 同一文件的多页收成一行：一本书命中五页时，列五行「同一本书」
      // 只是噪音，但那五个页码必须各自可点——答案里引的就是不同页。
      const byFile = new Map<string, Source[]>();
      for (const s of sources) {
        const arr = byFile.get(s.path);
        if (arr) arr.push(s);
        else byFile.set(s.path, [s]);
      }

      let i = 0;
      for (const [, group] of byFile) {
        const row = refs.createDiv({ cls: "kai-ref" });
        row.createSpan({ cls: "kai-ref-idx", text: `${++i}.` });
        row.createSpan({ cls: "kai-ref-title", text: group[0].title });

        const pages = group.filter((s) => s.page).sort((a, b) => a.page - b.page);
        if (pages.length) {
          for (const s of pages) this.refLink(row, refs, s, t("answer.page", { page: s.page }));
        } else {
          // markdown 没有页码，整行可点
          row.addClass("kai-ref-plain");
          this.bindRef(row, refs, group[0]);
        }
      }
    }

    const actions = turn.createDiv({ cls: "kai-actions" });
    this.actionBtn(actions, "lucide-clipboard", t("answer.copy"), () => {
      void navigator.clipboard.writeText(answer);
      new Notice(t("answer.copied"));
    });
    this.actionBtn(actions, "lucide-file-plus", t("answer.saveAs"), () =>
      void this.saveAsNote(answer, sources)
    );
    // 只有弹窗给了 detach 才显示——面板里再「在面板中打开」没有意义
    if (this.host.detach) {
      this.actionBtn(actions, "lucide-panel-right", t("answer.openInPane"), () =>
        this.host.detach?.(this.state())
      );
    }
    this.scrollToBottom();
  }

  /** 一个可点的页码。同一行里可以有多个。 */
  private refLink(row: HTMLElement, refs: HTMLElement, s: Source, label: string) {
    const el = row.createSpan({ cls: "kai-ref-page", text: label });
    this.bindRef(el, refs, s);
  }

  private bindRef(el: HTMLElement, refs: HTMLElement, s: Source) {
    el.addEventListener("click", (e) => void this.openSource(s, e));
    // 接原生悬停预览，鼠标停上去直接看原文，不用离开当前界面
    el.addEventListener("mouseover", (e) => {
      this.app.workspace.trigger("hover-link", {
        event: e,
        source: "knowledge-ai",
        hoverParent: refs,
        targetEl: el,
        linktext: linkFor(s),
      });
    });
  }

  private actionBtn(parent: HTMLElement, icon: string, label: string, cb: () => void) {
    const b = parent.createEl("button", { cls: "kai-action" });
    setIcon(b.createSpan(), icon);
    b.createSpan({ text: label });
    b.addEventListener("click", cb);
  }

  private async openSource(s: Source, evt: MouseEvent) {
    const newTab = evt.metaKey || evt.ctrlKey;
    if (!newTab) this.host.dismiss();
    await this.app.workspace.openLinkText(linkFor(s), "", newTab);

    // PDF 交给上面的 #page= 子路径处理，这里只管 markdown 的跳行
    if (s.page || s.line <= 1) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const line = Math.min(s.line - 1, view.editor.lastLine());
    view.editor.setCursor(line, 0);
    view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
  }

  private async saveAsNote(answer: string, sources: Source[]) {
    const q = this.records.at(-1)?.question ?? "Knowledge AI";
    const name = q.replace(/[\\/:*?"<>|#^[\]]/g, "").slice(0, 60).trim() || "Knowledge AI";
    const refs = sources.length
      ? "\n\n## " + t("answer.references") + "\n" +
        sources.map((s) => `- [[${s.path}]]`).join("\n")
      : "";
    const body = `# ${q}\n\n${answer}${refs}\n`;
    try {
      const file = await this.app.vault.create(`${name}.md`, body);
      await this.app.workspace.getLeaf(true).openFile(file);
      this.host.dismiss();
    } catch (e) {
      new Notice(t("error.generic", { message: e instanceof Error ? e.message : String(e) }));
    }
  }
}

/**
 * 引用要跳到的位置。
 *
 * PDF 必须带 `#page=N` 子路径——只给文件路径的话，Obsidian 每次都从第 1 页打开，
 * 引用里标着「第 38 页」却跳不过去。这个语法是 Obsidian 原生 PDF 视图认的，
 * 和手写 `[[某文档.pdf#page=38]]` 完全一样，不依赖任何第三方插件。
 */
function linkFor(s: Source): string {
  return s.page ? `${s.path}#page=${s.page}` : s.path;
}

/**
 * 发送前把图缩到长边 1024。
 *
 * 视觉模型按图块计费：Retina 截图动辄 2844×1076，换算下来近 4000 token，
 * 一张图就能把 4096 窗口占满，连问题都塞不进去。缩到 1024 后约 500 token，
 * 而对「图里有什么」这类问题，1024 的细节完全够用。
 */
async function downscale(dataUrl: string, maxSide = 1024): Promise<string> {
  const img = new Image();
  const loaded = new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error(t("error.imgDecode")));
  });
  img.src = dataUrl;
  try {
    await loaded;
  } catch {
    return dataUrl;                       // 解不开就原样发，让端点去报错
  }
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return dataUrl;

  const canvas = createEl("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // JPEG 比 PNG 小得多，截图这种内容 0.85 质量看不出差别
  return canvas.toDataURL("image/jpeg", 0.85);
}
