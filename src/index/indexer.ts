import * as path from "path";
import { TFile, Vault } from "obsidian";
import { Embedder } from "../embedder";
import { chunkText, pageMap } from "./chunker";
import { cacheKey, cleanPdfCache, extractPdf, pdfAvailable } from "./pdf";
import { describeImage, isImage } from "./describe";
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
        this.store.removePaths(new Set([file.path]));   // 先清旧块再写新块

        for (let b = 0; b < cks.length; b += EMBED_BATCH) {
          if (this.aborted) break;
          const batch = cks.slice(b, b + EMBED_BATCH);
          const vecs = await this.embedder.embed(batch.map((c) => c.text));
          const metas: ChunkMeta[] = batch.map((c) => ({
            path: file.path,
            mtime: file.stat.mtime,
            line: c.line,
            page: c.page,
            text: c.text,
          }));
          this.store.add(metas, vecs);
          chunks += metas.length;
        }

        // 每处理完一个文件就落盘一次，中途退出也不用从头再来
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

/**
 * 这个路径是否落在被忽略的文件夹里。
 *
 * 按路径段比较，不用 startsWith 裸比——否则填 "Eval" 会连
 * "Evaluation/" 一起挡掉。填单个文件的完整路径也支持，
 * 因为想藏起来的往往就是某一个文件而不是整个目录。
 */
export function isIgnored(filePath: string, ignoreFolders: string[]): boolean {
  if (!ignoreFolders?.length) return false;
  const p = filePath.replace(/^\/+/, "");
  return ignoreFolders.some((raw) => {
    const d = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!d) return false;
    return p === d || p.startsWith(d + "/");
  });
}
