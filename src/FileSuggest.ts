import { App, FuzzySuggestModal, TFile } from "obsidian";
import { t } from "./i18n";

/**
 * 选一个文件加进检索范围。
 *
 * 只列已经进过索引的类型（md / pdf）——选一个没被索引的文件，
 * 限定范围之后会一段都召不回，看着像插件坏了。
 */
export class FileSuggest extends FuzzySuggestModal<TFile> {
  private onPick: (f: TFile) => void;
  private exclude: Set<string>;

  constructor(app: App, exclude: string[], onPick: (f: TFile) => void) {
    super(app);
    this.onPick = onPick;
    this.exclude = new Set(exclude);
    this.setPlaceholder(t("files.pick"));
  }

  /**
   * 按最近打开排序：刚看过的排最前，没打开过的按修改时间兜底。
   *
   * 只影响没输入关键词时的初始列表——一旦开始打字，FuzzySuggestModal
   * 会按匹配度重排。但初始那一屏恰恰是最需要「刚才那个文件」的时候。
   */
  getItems(): TFile[] {
    const recent = new Map<string, number>();
    (this.app.workspace.getLastOpenFiles() ?? []).forEach((p, i) => recent.set(p, i));

    return this.app.vault
      .getFiles()
      .filter((f) => /^(md|pdf)$/i.test(f.extension) && !this.exclude.has(f.path))
      .sort((a, b) => {
        const ra = recent.get(a.path);
        const rb = recent.get(b.path);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return b.stat.mtime - a.stat.mtime;
      });
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}
