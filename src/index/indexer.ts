import * as path from "path";
import { TFile, Vault } from "obsidian";
import { Embedder } from "../embedder";
import { chunkText, pageMap } from "./chunker";
import { cacheKey, cleanPdfCache, extractPdf, pdfAvailable } from "./pdf";
import { describeImage, isImage } from "./describe";
import { isIgnored } from "./ignore";
import type { KnowledgeAiSettings } from "../settings";
import { IndexStore, type ChunkMeta } from "./store";

export interface Progress {
  done: number;      // 已处理文件数
  total: number;
  chunks: number;    // 累计新增块数
  current: string;   // 当前文件名
}

const EMBED_BATCH = 32;

export class Indexer {
  private aborted = false;
  running = false;

  constructor(
    private vault: Vault,
    private store: IndexStore,
    private embedder: Embedder,
    private settings: KnowledgeAiSettings
  ) {}

  private get pdfCacheDir(): string {
    return path.join(this.store.location, "pdftext");
  }

  private get imgCacheDir(): string {
    return path.join(this.store.location, "imgdesc");
  }

  abort(): void {
    this.aborted = true;
  }

  /** 增量：只处理新增和 mtime 变过的文件，删掉已消失文件的块。 */
  async run(
    scopeFolders: string[],
    onProgress: (p: Progress) => void
  ): Promise<{ files: number; chunks: number; removed: number; seconds: number; failed: string[] }> {
    this.aborted = false;
    this.running = true;
    const t0 = performance.now();

    try {
      // 先确认存储目录可写。放在最前面：路径不可写时，后面每一步都是白做的
      const werr = await this.store.checkWritable();
      if (werr) throw new Error(`索引存储位置不可写（${this.store.location}）：${werr}`);

      // 换模型会让旧向量不可比，setModel 内部会作废重建
      const probe = await this.embedder.probe();
      this.store.setModel(this.embedder.model, probe.dim);

      const files = this.targets(scopeFolders);
      const present = new Set(files.map((f) => f.path));

      // 库里已经没有的文件，把它的块清掉
      const stale = new Set<string>();
      for (const p of this.store.indexedPaths()) if (!present.has(p)) stale.add(p);
      this.store.removePaths(stale);

      const todo = files.filter((f) => this.store.mtimeOf(f.path) !== f.stat.mtime);
      let chunks = 0;
      const failed: string[] = [];

      for (let i = 0; i < todo.length; i++) {
        if (this.aborted) break;
        const file = todo[i];
        onProgress({ done: i, total: todo.length, chunks, current: file.name });

        const isPdf = file.extension.toLowerCase() === "pdf";
        const isImg = isImage(file);

        // 单个文件的失败不该带走整轮索引。
        // 早先只有 describeImage / extractPdf 会返回错误对象、被跳过；
        // cachedRead、embed、store.add 抛出的异常会一路冒到最外层，
        // 后面几千个文件一个都不再处理——而界面上只有一句笼统的报错。
        // 实测触发过：把存储位置填成只读路径，save() 抛 EROFS，
        // 索引停在第 30 篇，看上去就像「库里只有 30 篇笔记」。
        try {
          let body: string;
          if (isImg) {
            const d = await describeImage(this.vault, file, this.settings, this.imgCacheDir);
            if (d.error || !d.text) {
              failed.push(`${file.name}: ${d.error ?? "描述为空"}`);
              continue;
            }
            // 描述文本前面带上文件名，让「找那张架构图」这类问题也能命中
            body = `${file.name}\n\n${d.text}`;
          } else if (isPdf) {
            const r = await extractPdf(this.vault, file, this.pdfCacheDir);
            if ("error" in r) {
              failed.push(`${file.name}: ${r.error}`);
              continue;
            }
            body = r.text;
          } else {
            body = await this.vault.cachedRead(file);
          }
          // PDF 的块要带页码，引用时才能说「第 678 页」而不是「行 47369」
          const cks = chunkText(body, isPdf ? pageMap(body) : undefined);

          // 先把新块算完再删旧块。反过来做的话，嵌入中途失败就意味着
          // 旧块已经删了、新块没写进去——这个文件从索引里静默消失，
          // 而且下一次落盘会把这个状态固化下来
          const fresh: { metas: ChunkMeta[]; vecs: Float32Array[] }[] = [];
          for (let b = 0; b < cks.length; b += EMBED_BATCH) {
            if (this.aborted) break;
            const batch = cks.slice(b, b + EMBED_BATCH);
            const vecs = await this.embedder.embed(batch.map((c) => c.text));
            fresh.push({
              metas: batch.map((c) => ({
                path: file.path,
                mtime: file.stat.mtime,
                line: c.line,
                page: c.page,
                text: c.text,
              })),
              vecs,
            });
          }
          if (this.aborted) break;

          this.store.removePaths(new Set([file.path]));
          for (const f of fresh) {
            this.store.add(f.metas, f.vecs);
            chunks += f.metas.length;
          }
        } catch (e) {
          failed.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }

        // 每处理完一个文件就落盘一次，中途退出也不用从头再来。
        // 落盘失败是全局性的（磁盘满、路径不可写），继续跑下去没有意义，
        // 直接抛出去让外层报错——这与单个文件失败是两回事
        if (i % 10 === 9) await this.store.save();
      }

      await this.store.save();
      // 清掉源文件已消失或已改动的 PDF 缓存
      await cleanPdfCache(this.pdfCacheDir, new Set(files.filter(isPdfFile).map(cacheKey)));
      onProgress({ done: todo.length, total: todo.length, chunks, current: "" });
      return {
        files: todo.length,
        chunks,
        removed: stale.size,
        seconds: (performance.now() - t0) / 1000,
        failed,
      };
    } finally {
      this.running = false;
    }
  }

  private targets(scopeFolders: string[]): TFile[] {
    let all: TFile[] = this.vault.getMarkdownFiles();
    if (this.settings.includePdf && pdfAvailable()) {
      all = all.concat(this.vault.getFiles().filter(isPdfFile));
    }
    if (this.settings.describeImages) {
      all = all.concat(this.vault.getFiles().filter(isImage));
    }
    if (scopeFolders.length > 0) {
      all = all.filter((f) => scopeFolders.some((d) => f.path.startsWith(d.replace(/\/*$/, "/"))));
    }
    // 排除在范围之后：显式忽略优先于显式包含，
    // 免得同时填了两处时还要猜哪个说了算
    return all.filter((f) => !isIgnored(f.path, this.settings.ignoreFolders));
  }
}

function isPdfFile(f: TFile): boolean {
  return f.extension.toLowerCase() === "pdf";
}
