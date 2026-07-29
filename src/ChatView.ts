import { ItemView, Notice, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { Conversation, type ConvState } from "./Conversation";
import { t } from "./i18n";
import type KnowledgeAiPlugin from "./main";

export const VIEW_TYPE_CHAT = "knowledge-ai-chat";

/** 存进 workspace.json 的对话轮数上限。每次布局变动都要写盘，不能无限涨。 */
const STATE_TURNS = 20;

/** 面板能待的两个地方。弹窗是第三个位置，但它不是 leaf，不在这里管。 */
export type PaneWhere = "right" | "center";

/**
 * 常驻面板。和弹窗是同一个 Conversation，只是外壳不同：
 *
 *   弹窗   —— 唤起式，问完就关，点引用自动收起，让路给笔记
 *   右侧   —— 常驻窄栏，边看笔记边追问
 *   中间   —— 主编辑区标签页，长对话读起来舒服
 *
 * 标题栏的按钮在右侧/中间之间搬家，走的是「记下会话 → 关掉旧 leaf →
 * 在新位置重建」这条路：Obsidian 没有直接移动 leaf 的 API，
 * 而会话本来就是可序列化的，重建的代价只是重画一遍。
 */
export class ChatView extends ItemView {
  private plugin: KnowledgeAiPlugin;
  private conv!: Conversation;
  /** onOpen 之前被 adopt 塞进来的会话，等 DOM 建好再灌 */
  private queued: ConvState | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KnowledgeAiPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText() {
    return t("plugin.name");
  }

  getIcon() {
    return "wand-sparkles";   // sparkles 不在 Obsidian 的图标集里，会渲染成空白
  }

  /** 当前所在位置。主编辑区的 leaf 挂在 rootSplit 下。 */
  get where(): PaneWhere {
    return this.leaf.getRoot() === this.app.workspace.rootSplit ? "center" : "right";
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.addClass("kai-pane");
    // 中间面板很宽，正文要限宽居中，否则一行拉到头没法读
    root.toggleClass("kai-pane-center", this.where === "center");

    // 面板没有 detach——已经在面板里了
    this.conv = new Conversation(this.app, this.plugin, {
      dismiss: () => {
        /* 常驻面板，点引用不收起 */
      },
    });
    this.conv.mount(root, {
      inputAtTop: false,
      dropTarget: this.containerEl,
      pickFiles: true,
      homeStyle: true,
    });

    this.addAction("rotate-ccw", t("pane.reset"), () => this.conv.reset());

    const target: PaneWhere = this.where === "center" ? "right" : "center";
    this.addAction(
      target === "center" ? "gallery-vertical" : "panel-right",
      t(target === "center" ? "pane.toCenter" : "pane.toRight"),
      () => void this.relocate(target)
    );

    if (this.queued) {
      this.conv.restore(this.queued);
      this.queued = null;
    }
    this.conv.focus();
  }

  async onClose() {
    this.conv?.destroy();
  }

  /**
   * 把会话交给 Obsidian 的视图状态，随 workspace 一起存盘。
   *
   * 侧边栏折叠时 Obsidian 会卸载视图（1.7 起的延迟视图机制），
   * onClose 销毁 conv、重新展开时 onOpen 建一个全新的空的——
   * 不接这一层的话，折一下侧栏对话就没了。存进 state 之后，
   * 折叠、重开、重启 Obsidian 都能接着聊。
   *
   * 只留最近 STATE_TURNS 轮：workspace.json 每次布局变动都要写盘，
   * 把几十轮长答案塞进去会让它涨到几百 KB。
   */
  getState(): Record<string, unknown> {
    const conv = this.conv ? this.conv.state() : this.queued;
    return {
      ...super.getState(),
      conv: conv ? { ...conv, turns: conv.turns.slice(-STATE_TURNS) } : undefined,
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const conv = (state as { conv?: ConvState } | null)?.conv;
    if (conv?.turns) this.adopt(conv);
  }

  /** 从弹窗或另一侧面板搬过来的会话。可能在 onOpen 之前调用，所以先存着。 */
  adopt(state: ConvState) {
    // 两边都记：conv 已经在了就直接重画，同时留一份给「视图被卸载后重建」
    this.queued = state;
    if (this.conv) {
      this.conv.restore(state);
      this.conv.focus();
    }
  }

  private async relocate(where: PaneWhere) {
    // 生成中搬家会把请求掐掉，答案就没了——让用户等一下比默默丢弃好
    if (this.conv.busy) {
      new Notice(t("pane.busy"));
      return;
    }
    const state = this.conv.state();
    this.leaf.detach();
    await this.plugin.openChatPane(state, where);
  }
}
