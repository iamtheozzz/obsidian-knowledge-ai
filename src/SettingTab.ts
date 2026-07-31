import { App, PluginSettingTab, Setting } from "obsidian";
import { t } from "./i18n";
import { testChat, testEmbed, testPdf, testVision } from "./tester";
import { listEmbedModels, listModels, modelLabel, type ModelInfo, type ModelList } from "./models";
import type KnowledgeAiPlugin from "./main";
import { normalizeIgnoreList } from "./index/ignore";

export class KnowledgeAiSettingTab extends PluginSettingTab {
  private plugin: KnowledgeAiPlugin;
  /** 探测到的模型列表。null = 还没探测过，探到之后重绘一次换成下拉框 */
  private models: ModelList | null = null;
  private embedModels: ModelInfo[] | null = null;
  private detecting = false;
  /** 提交忽略规则。由 display() 建好，blur 和 hide() 共用 */
  private flushIgnore: ((redraw: boolean) => Promise<void>) | null = null;

  constructor(app: App, plugin: KnowledgeAiPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    // 填完忽略规则直接关窗时 blur 不一定触发，这里补一次提交。
    // 不重绘——页面正在关闭
    void this.flushIgnore?.(false);
    // 关掉设置页后重新探测，端点或已装模型可能变了
    this.models = null;
    this.embedModels = null;
  }

  /** 探测一次后重绘。display() 是同步的，所以只能先渲染文本框、拿到结果再换。 */
  private detectOnce(): void {
    if (this.detecting || this.models !== null) return;
    this.detecting = true;
    void Promise.all([listModels(this.plugin.settings), listEmbedModels(this.plugin.settings)])
      .then(([m, e]) => {
        this.models = m;
        this.embedModels = e;
      })
      .catch(() => {
        this.models = { chat: [], embed: [], vision: [], enriched: false, error: "探测失败" };
      })
      .finally(() => {
        this.detecting = false;
        this.display();
      });
  }

  /** 探测到了就给下拉框，没探到就退回文本框——自建端点未必实现 /v1/models */
  private modelControl(
    setting: Setting,
    options: ModelInfo[],
    current: string,
    onPick: (v: string) => Promise<void>
  ): void {
    if (options.length === 0) {
      setting.addText((x) =>
        x.setValue(current).onChange(async (v) => onPick(v.trim()))
      );
      return;
    }
    setting.addDropdown((d) => {
      // 已填的值不在探测结果里也要保留，否则会被静默改掉
      if (current && !options.some((o) => o.id === current)) d.addOption(current, current);
      for (const o of options) d.addOption(o.id, modelLabel(o));
      d.setValue(current || options[0].id);
      d.onChange(async (v) => onPick(v));
      if (!current && options[0]) void onPick(options[0].id);
    });
  }

  private showResult(el: HTMLElement, ok: boolean, text: string): void {
    el.empty();
    el.toggleClass("kai-test-ok", ok);
    el.toggleClass("kai-test-err", !ok);
    el.setText((ok ? "✓ " : "✗ ") + text);
  }

  display(): void {
    const { containerEl: c } = this;
    c.empty();
    this.detectOnce();

    // ── 模型 ──────────────────────────────────────────
    new Setting(c).setName(t("settings.model.section")).setHeading();

    new Setting(c)
      .setName(t("settings.model.endpoint"))
      .setDesc(t("settings.model.endpointDesc"))
      .addText((x) =>
        x.setValue(this.plugin.settings.endpoint).onChange(async (v) => {
          this.plugin.settings.endpoint = v.trim();
          await this.plugin.saveSettings();
          this.models = null;          // 端点变了，重新探测
          this.detectOnce();
        })
      );

    const chatSetting = new Setting(c).setName(t("settings.model.chatModel"));
    if (this.models?.error) chatSetting.setDesc(this.models.error);
    this.modelControl(
      chatSetting,
      this.models?.chat ?? [],
      this.plugin.settings.chatModel,
      async (v) => {
        this.plugin.settings.chatModel = v;
        await this.plugin.saveSettings();
      }
    );
    chatSetting
      .addButton((b) =>
        b.setButtonText(t("settings.model.test")).onClick(async () => {
          b.setButtonText(t("settings.model.testing")).setDisabled(true);
          const r = await testChat(this.plugin.settings);
          this.showResult(chatResult, r.ok, r.text);
          b.setButtonText(t("settings.model.test")).setDisabled(false);
        })
      );
    const chatResult = c.createDiv({ cls: "kai-test-result" });

    const visionSetting = new Setting(c)
      .setName(t("settings.model.visionModel"))
      .setDesc(t("settings.model.visionDesc"));
    this.modelControl(
      visionSetting,
      this.models?.vision ?? [],
      this.plugin.settings.visionModel,
      async (v) => {
        this.plugin.settings.visionModel = v;
        await this.plugin.saveSettings();
      }
    );
    visionSetting.addButton((b) =>
      b.setButtonText(t("settings.model.test")).onClick(async () => {
        b.setButtonText(t("settings.model.testing")).setDisabled(true);
        const r = await testVision(this.plugin.settings);
        this.showResult(visionResult, r.ok, r.text);
        b.setButtonText(t("settings.model.test")).setDisabled(false);
      })
    );
    const visionResult = c.createDiv({ cls: "kai-test-result" });

    new Setting(c)
      .setName(t("settings.model.apiKey"))
      .addText((x) => {
        x.inputEl.type = "password";
        x.setValue(this.plugin.settings.apiKey).onChange(async (v) => {
          this.plugin.settings.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    // ── 语言 ──────────────────────────────────────────
    new Setting(c).setName(t("settings.lang.section")).setHeading();

    new Setting(c)
      .setName(t("settings.lang.ui"))
      .setDesc(t("settings.lang.uiDesc"))
      .addDropdown((d) =>
        d
          .addOption("auto", t("settings.lang.followObsidian"))
          .addOption("zh", "简体中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.uiLang)
          .onChange(async (v) => {
            this.plugin.settings.uiLang = v as typeof this.plugin.settings.uiLang;
            await this.plugin.saveSettings();
            this.display();               // 立刻用新语言重绘设置页
            this.plugin.refreshRibbon();
          })
      );

    new Setting(c)
      .setName(t("settings.lang.answer"))
      .setDesc(t("settings.lang.answerDesc"))
      .addDropdown((d) =>
        d
          .addOption("auto", t("settings.lang.followQuestion"))
          .addOption("zh", "简体中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.answerLang)
          .onChange(async (v) => {
            this.plugin.settings.answerLang =
              v as typeof this.plugin.settings.answerLang;
            await this.plugin.saveSettings();
          })
      );

    // ── 索引 ──────────────────────────────────────────
    new Setting(c).setName(t("settings.index.section")).setHeading();

    new Setting(c)
      .setName(t("index.auto"))
      .setDesc(t("index.autoDesc"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.autoIndex).onChange(async (v) => {
          this.plugin.settings.autoIndex = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(c)
      .setName(t("settings.index.retrieval"))
      .setDesc(t("settings.index.retrievalDesc"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.vaultRetrieval).onChange(async (v) => {
          this.plugin.settings.vaultRetrieval = v;
          await this.plugin.saveSettings();
        })
      );

    const ignoreSetting = new Setting(c)
      .setName(t("settings.index.ignore"))
      .setDesc(t("settings.index.ignoreDesc"))
      .addTextArea((x) => {
        x.setPlaceholder(t("settings.index.ignorePlaceholder"))
          .setValue(this.plugin.settings.ignoreFolders.join("\n"));
        x.inputEl.rows = 4;
        x.inputEl.addClass("kai-ignore-input");
        // 不用 onChange 落盘：它逐字符触发，边打字边 purge 会把还没输完的
        // 半截路径当成规则，先删掉一批块再加回来。改为失焦时提交，
        // 并在设置页关闭时补一次——否则填完直接关窗，这一栏就白填了
        this.flushIgnore = async (redraw: boolean) => {
          const next = normalizeIgnoreList(x.getValue().split("\n"));
          const prev = this.plugin.settings.ignoreFolders;
          if (next.length === prev.length && next.every((v, i) => v === prev[i])) return;
          this.plugin.settings.ignoreFolders = next;
          await this.plugin.saveSettings();
          const removed = await this.plugin.purgeIgnored();
          if (removed > 0) this.plugin.notify(t("index.ignorePurged", { n: removed }));
          if (redraw) this.display();
        };
        x.inputEl.addEventListener("blur", () => void this.flushIgnore?.(true));
      });
    // 填完立刻能看到挡住了多少个文件，否则完全不知道规则有没有写对
    ignoreSetting.descEl.createDiv({
      cls: "kai-hint",
      text: t("settings.index.ignoreCount", { n: this.plugin.ignoredCount() }),
    });

    new Setting(c)
      .setName(t("settings.index.includePdf"))
      .setDesc(t("settings.index.includePdfDesc"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.includePdf).onChange(async (v) => {
          this.plugin.settings.includePdf = v;
          await this.plugin.saveSettings();
        })
      )
      .addButton((b) =>
        b.setButtonText(t("settings.model.test")).onClick(async () => {
          b.setButtonText(t("settings.model.testing")).setDisabled(true);
          const r = await testPdf(this.app.vault, this.plugin.pdfCacheDir());
          this.showResult(pdfResult, r.ok, r.text);
          b.setButtonText(t("settings.model.test")).setDisabled(false);
        })
      );
    const pdfResult = c.createDiv({ cls: "kai-test-result" });

    const imgSetting = new Setting(c)
      .setName(t("settings.index.describeImages"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.describeImages).onChange(async (v) => {
          this.plugin.settings.describeImages = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );
    imgSetting.descEl.createDiv({
      text: t("settings.index.describeImagesDesc", {
        n: this.plugin.imageCount(),
        minutes: Math.max(1, Math.round(this.plugin.imageCount() * 12 / 60)),
      }),
    });
    if (this.plugin.settings.describeImages) {
      imgSetting.descEl.createDiv({
        cls: "kai-warn",
        text: t("settings.index.describeImagesWarn"),
      });
    }

    new Setting(c)
      .setName(t("settings.index.embedEndpoint"))
      .setDesc(t("settings.index.embedEndpointDesc"))
      .addText((x) =>
        x
          .setPlaceholder(this.plugin.settings.endpoint)
          .setValue(this.plugin.settings.embedEndpoint)
          .onChange(async (v) => {
            this.plugin.settings.embedEndpoint = v.trim();
            await this.plugin.saveSettings();
            this.models = null;
            this.embedModels = null;
            this.detectOnce();
          })
      );

    const embedSetting = new Setting(c)
      .setName(t("settings.index.embedModel"));
    // 换模型的代价必须写在眼皮底下——不同模型的向量不可比，
    // 换了就等于整个索引作废，而这一点从界面上完全看不出来
    embedSetting.descEl.createDiv({ text: "bge-m3 / nomic-embed-text 等，需端点上已存在" });
    embedSetting.descEl.createDiv({
      cls: "kai-warn",
      text: t("index.embedWarn", {
        minutes: Math.max(1, Math.round(this.plugin.estimatedChunks() / 11.5 / 60)),
      }),
    });
    this.modelControl(
      embedSetting,
      (this.embedModels?.length ? this.embedModels : this.models?.embed) ?? [],
      this.plugin.settings.embedModel,
      async (v) => {
        this.plugin.settings.embedModel = v;
        await this.plugin.saveSettings();
      }
    );
    embedSetting
      .addButton((b) =>
        b.setButtonText(t("settings.model.test")).onClick(async () => {
          b.setButtonText(t("settings.model.testing")).setDisabled(true);
          const r = await testEmbed(this.plugin.settings, this.plugin.estimatedChunks());
          this.showResult(embedResult, r.ok, r.text);
          b.setButtonText(t("settings.model.test")).setDisabled(false);
        })
      );
    const embedResult = c.createDiv({ cls: "kai-test-result" });

    const storeSetting = new Setting(c)
      .setName(t("settings.index.storage"))
      .setDesc(t("settings.index.storageDesc"))
      .addText((x) =>
        x.setPlaceholder("(default)").setValue(this.plugin.settings.indexDir)
          .onChange(async (v) => {
            this.plugin.settings.indexDir = v.trim();
            await this.plugin.saveSettings();
          })
      );
    // 填了相对路径会被静默退回默认位置。不说一声的话，用户会以为自己指定的
    // 位置生效了，而实际索引写在别处——这一栏填错的代价比看上去大
    if (this.plugin.store.dirError) {
      storeSetting.descEl.createDiv({
        cls: "kai-warn",
        text: t("settings.index.storageRelative", { path: this.plugin.store.dirError }),
      });
    }

    const busy = Boolean(this.plugin.indexer?.running);
    new Setting(c)
      .setName(t("settings.index.status"))
      // 正在跑的时候要在这里就能看出来，否则用户点了按钮才知道
      .setDesc(
        (busy ? t("index.busy") + " · " : "") +
          this.plugin.indexSummary() + " · " + this.plugin.store.location
      )
      .addButton((b) =>
        b
          // 这个按钮走的是增量：mtime 没变的文件一个都不重跑。
          // 早先写「重建索引」是文案与行为不符，容易让人不敢点。
          .setButtonText(
            this.plugin.store.size === 0 ? t("index.start") : t("index.update")
          )
          .setCta()
          .setDisabled(busy)
          .onClick(async () => {
            b.setDisabled(true);
            await this.plugin.buildIndex();
            b.setDisabled(false);
            this.display();
          })
      );

    if (this.plugin.store.size > 0) {
      new Setting(c)
        .setName(t("index.rebuildFull"))
        .setDesc(t("index.rebuildDesc"))
        .addButton((b) =>
          // setWarning 已被 setDestructive 取代，但后者是 1.13.0 才有的，
          // 而 minAppVersion 是 1.7.2——用了会触发 no-unsupported-api。
          // 等 1.13 普及之后再换。
          b.setButtonText(t("index.rebuildFull")).setWarning().onClick(async () => {
            b.setDisabled(true);
            await this.plugin.rebuildIndex();
            b.setDisabled(false);
            this.display();
          })
        );
    }

    // ── 高级 ──────────────────────────────────────────
    new Setting(c).setName(t("settings.advanced.section")).setHeading();

    new Setting(c).setName(t("settings.advanced.topK")).addSlider((s) =>
      s
        .setLimits(3, 20, 1)
        .setValue(this.plugin.settings.topK)
        .onChange(async (v) => {
          this.plugin.settings.topK = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(c).setName(t("settings.advanced.threshold")).addSlider((s) =>
      s
        .setLimits(0.3, 0.8, 0.05)
        .setValue(this.plugin.settings.threshold)
        .onChange(async (v) => {
          this.plugin.settings.threshold = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(c)
      .setName(t("set.newTabHome"))
      .setDesc(t("set.newTabHomeDesc"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.newTabHome).onChange(async (v) => {
          this.plugin.settings.newTabHome = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(c).setName(t("set.ribbon")).addToggle((x) =>
      x.setValue(this.plugin.settings.showRibbon).onChange(async (v) => {
        this.plugin.settings.showRibbon = v;
        await this.plugin.saveSettings();
        this.plugin.refreshRibbon();
      })
    );
  }
}
