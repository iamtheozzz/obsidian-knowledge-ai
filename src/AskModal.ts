import { App, Modal, TFile } from "obsidian";
import { t } from "./i18n";
import { Conversation, type ConvState } from "./Conversation";
import type KnowledgeAiPlugin from "./main";

/**
 * 提问弹窗。外观完全等同 Quick Switcher：水平居中、顶部 80px 起、
 * 700px 宽、70vh 高上限——这是主入口。
 *
 * 对话本身全在 Conversation 里，这里只负责外壳：浮层样式、
 * 点引用后自动关掉、以及把会话交给面板。
 */
export class AskModal extends Modal {
  private plugin: KnowledgeAiPlugin;
  private prefill?: string;
  private noteImages: TFile[];
  private conv!: Conversation;

  constructor(
    app: App, plugin: KnowledgeAiPlugin, prefill?: string, noteImages: TFile[] = []
  ) {
    super(app);
    this.plugin = plugin;
    this.prefill = prefill;
    this.noteImages = noteImages;
  }

  onOpen() {
    // 伪装成原生 prompt：去掉 .modal 换上 .prompt，尺寸/位置/圆角/阴影
    // 全部继承 Quick Switcher 那一套（700px · 80vw · 70vh · 顶部 80px）。
    // Omnisearch 用的就是这个办法——自己写死尺寸的话，用户换主题就对不上了。
    this.modalEl.addClass("kai-modal", "prompt");
    this.modalEl.removeClass("modal");
    // 原生 prompt 没有关闭叉，留着会和 .prompt 的内边距打架
    this.modalEl.querySelector(".modal-close-button")?.remove();

    this.conv = new Conversation(this.app, this.plugin, {
      dismiss: () => this.close(),
      detach: (s) => this.detach(s),
    });
    this.conv.mount(this.contentEl, { inputAtTop: true, dropTarget: this.modalEl });
    this.conv.setNoteImages(this.noteImages);

    if (this.prefill) this.conv.setDraft(this.prefill);
    this.conv.focus();
    this.renderInstructions();
  }

  /** 底部按键提示。用原生 prompt-instruction 类，主题怎么改它都跟着走。 */
  private renderInstructions() {
    const box = this.contentEl.createDiv({ cls: "prompt-instructions" });
    const rows: [string, string][] = [
      ["↵", t("hint.send")],
      ["shift ↵", t("hint.newline")],
      ["esc", t("hint.dismiss")],
    ];
    for (const [key, label] of rows) {
      const row = box.createDiv({ cls: "prompt-instruction" });
      row.createSpan({ cls: "prompt-instruction-command", text: key });
      row.createSpan({ text: label });
    }
  }

  onClose() {
    this.conv?.destroy();
    this.contentEl.empty();
  }

  /** 会话原样搬到右侧面板，弹窗让位 */
  private detach(state: ConvState) {
    this.close();
    void this.plugin.openChatPane(state);
  }
}
