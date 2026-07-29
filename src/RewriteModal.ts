import { App, Editor, Modal, Notice, Setting } from "obsidian";
import { StreamCleaner } from "./clean";
import { resolveAnswerLang, t } from "./i18n";
import { rewriteSystem, rewriteUser } from "./prompts";
import { streamChat } from "./stream";
import type KnowledgeAiPlugin from "./main";

/**
 * 预置指令。覆盖绝大多数「改一下这段」的实际需求，省得每次自己敲。
 *
 * 指令本身要跟着选区语言走：把中文指令发给一段英文原文，
 * 模型多半会连指令一起翻译进结果里。
 */
const PRESETS: Array<{ key: string; zh: string; en: string }> = [
  {
    key: "rewrite.preset.concise",
    zh: "改写得更简洁，去掉冗余，保留全部信息量。",
    en: "Make this more concise. Cut redundancy but keep all the information.",
  },
  {
    key: "rewrite.preset.clear",
    zh: "改写得更清楚易读，可以调整语序和断句。",
    en: "Make this clearer and easier to read. You may reorder clauses and re-break sentences.",
  },
  {
    key: "rewrite.preset.formal",
    zh: "改写成更正式的书面语。",
    en: "Rewrite this in more formal prose.",
  },
  {
    key: "rewrite.preset.summary",
    zh: "浓缩成要点，用短句列出。",
    en: "Condense this into key points, listed as short lines.",
  },
  {
    key: "rewrite.preset.expand",
    zh: "在不引入新事实的前提下展开说明，补充必要的过渡。",
    en: "Expand on this without introducing new facts; add the transitions it needs.",
  },
  {
    key: "rewrite.preset.en",
    zh: "Translate into natural English, preserving meaning and tone.",
    en: "Translate into natural English, preserving meaning and tone.",
  },
];

/**
 * 选中改写。选一段 → 给个指令 → 看 diff → 确认替换。
 *
 * 走的是单次模型调用，不检索、不用工具：选中的那段本身就是全部材料。
 * 改动范围严格限定在选区内，diff 一目了然——这是它比「让 AI 自己去改
 * 某篇笔记」安全得多的地方。
 */
export class RewriteModal extends Modal {
  private plugin: KnowledgeAiPlugin;
  private editor: Editor;
  private original: string;

  private instructionEl!: HTMLTextAreaElement;
  private outEl!: HTMLDivElement;
  private applyBtn!: HTMLButtonElement;
  private controller: AbortController | null = null;
  private result = "";

  constructor(app: App, plugin: KnowledgeAiPlugin, editor: Editor, selection: string) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.original = selection;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    // 和提问弹窗同一套外观，见 AskModal 里的说明
    modalEl.addClass("kai-modal", "prompt");
    modalEl.removeClass("modal");
    modalEl.querySelector(".modal-close-button")?.remove();
    contentEl.empty();

    contentEl.createDiv({ cls: "kai-rw-title", text: t("rewrite.title", {
      n: this.original.length,
    }) });

    // 原文折叠着放，需要核对时点开
    const det = contentEl.createEl("details", { cls: "kai-rw-src" });
    det.createEl("summary", { text: t("rewrite.original") });
    det.createDiv({ cls: "kai-rw-pre", text: this.original });

    const chips = contentEl.createDiv({ cls: "kai-presets" });
    for (const p of PRESETS) {
      const chip = chips.createDiv({ cls: "kai-preset", text: t(p.key as never) });
      chip.addEventListener("click", () => {
        const lang = resolveAnswerLang(this.plugin.settings.answerLang, this.original);
        this.instructionEl.value = lang === "zh" ? p.zh : p.en;
        void this.run();
      });
    }

    this.instructionEl = contentEl.createEl("textarea", {
      cls: "kai-input kai-rw-input",
      attr: { rows: "2", placeholder: t("rewrite.placeholder") },
    });
    this.instructionEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.run();
      }
    });

    this.outEl = contentEl.createDiv({ cls: "kai-rw-out" });

    new Setting(contentEl)
      .addButton((b) => {
        this.applyBtn = b.buttonEl;
        b.setButtonText(t("rewrite.apply")).setCta().setDisabled(true).onClick(() => this.apply());
      })
      .addButton((b) => b.setButtonText(t("action.cancel")).onClick(() => this.close()))
      .settingEl.addClass("kai-actions");

    window.setTimeout(() => this.instructionEl.focus(), 0);
  }

  onClose() {
    this.controller?.abort();
    this.contentEl.empty();
  }

  private async run() {
    const instruction = this.instructionEl.value.trim();
    if (!instruction || this.controller) return;
    if (!this.plugin.settings.chatModel) {
      new Notice(t("error.noEndpoint"));
      return;
    }

    this.result = "";
    this.outEl.empty();
    this.outEl.createDiv({ cls: "kai-thinking" });
    this.applyBtn.disabled = true;
    this.controller = new AbortController();

    const lang = resolveAnswerLang(this.plugin.settings.answerLang, this.original);
    const cleaner = new StreamCleaner();
    try {
      await streamChat(
        this.plugin.settings,
        [
          { role: "system", content: rewriteSystem(lang) },
          { role: "user", content: rewriteUser(this.original, instruction) },
        ],
        this.controller.signal,
        (chunk) => {
          const vis = cleaner.push(chunk);
          if (vis) {
            this.result += vis;
            this.outEl.setText(this.result);
          }
        }
      );
      this.result = (this.result + cleaner.flush()).trim();
      this.renderDiff();
      this.applyBtn.disabled = this.result.length === 0;
    } catch (e) {
      this.outEl.addClass("kai-error");
      this.outEl.setText(t("error.generic", {
        message: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      this.controller = null;
    }
  }

  private renderDiff() {
    this.outEl.empty();
    this.outEl.removeClass("kai-error");
    for (const row of lineDiff(this.original, this.result)) {
      this.outEl.createDiv({
        cls: `kai-diff kai-diff-${row.kind}`,
        text: (row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  ") + row.text,
      });
    }
  }

  private apply() {
    if (!this.result) return;
    this.editor.replaceSelection(this.result);
    this.close();
  }
}

type DiffRow = { kind: "same" | "add" | "del"; text: string };

/**
 * 行级 diff。用最长公共子序列，够短文本用了。
 * 不引第三方 diff 库——几十行的事，没必要为它增加打包体积。
 */
function lineDiff(a: string, b: string): DiffRow[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: A[i++] });
    } else {
      out.push({ kind: "add", text: B[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: A[i++] });
  while (j < m) out.push({ kind: "add", text: B[j++] });
  return out;
}
