import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizePath } from "obsidian";

export interface ChunkMeta {
  path: string;    // 库内相对路径
  mtime: number;
  line: number;
  page: number;
  text: string;
}

export interface Hit extends ChunkMeta {
  score: number;
}

/** 子串出现次数。indexOf 循环比正则快，也不用担心转义。 */
function countOf(text: string, term: string): number {
  let n = 0;
  let i = text.indexOf(term);
  while (i !== -1) {
    n++;
    i = text.indexOf(term, i + term.length);
  }
  return n;
}

interface StoreHeader {
  version: 1;
  model: string;
  dim: number;
  count: number;
}

/**
 * 向量库。刻意存在库之外——索引是本机计算产物，几十 MB，
 * 放进 .obsidian/plugins/ 会被 Obsidian Sync 和 obsidian-git 一起同步走。
 *
 * 三个文件：header.json（模型和维度）/ chunks.jsonl（元数据）/ vectors.bin（Float32）。
 * 规模在几万块以内，整体载入内存后检索就是一次矩阵乘，够快也够简单。
 */
export class IndexStore {
  private dir: string;
  private metas: ChunkMeta[] = [];
  private vecs: Float32Array = new Float32Array(0);
  private dim = 0;
  private model = "";

  constructor(vaultName: string, customDir: string) {
    // 用户手填的路径先过 normalizePath：官方指南要求用它清理用户输入的路径，
    // 它会统一分隔符、去掉多余的斜杠和首尾空白。~ 要在那之前展开——
    // normalizePath 不认识它，留着会变成一个名叫 "~" 的目录。
    this.dir = customDir
      ? path.resolve(normalizePath(customDir.trim().replace(/^~(?=$|[/\\])/, os.homedir())))
      : path.join(defaultRoot(), sanitize(vaultName));
  }

  get location(): string {
    return this.dir;
  }
  get size(): number {
    return this.metas.length;
  }
  get fileCount(): number {
    return new Set(this.metas.map((m) => m.path)).size;
  }

  /** 分别统计笔记和 PDF，索引概况里要显示 */
  fileBreakdown(): { notes: number; pdfs: number } {
    const paths = new Set(this.metas.map((m) => m.path));
    let pdfs = 0;
    for (const p of paths) if (p.toLowerCase().endsWith(".pdf")) pdfs++;
    return { notes: paths.size - pdfs, pdfs };
  }
  get vectorDim(): number {
    return this.dim;
  }
  get embedModel(): string {
    return this.model;
  }

  /** 某个文件已索引时的 mtime，用于增量判断 */
  mtimeOf(p: string): number | undefined {
    for (const m of this.metas) if (m.path === p) return m.mtime;
    return undefined;
  }

  indexedPaths(): Set<string> {
    return new Set(this.metas.map((m) => m.path));
  }

  async load(): Promise<void> {
    try {
      const head = JSON.parse(
        await fs.promises.readFile(path.join(this.dir, "header.json"), "utf8")
      ) as StoreHeader;
      const jsonl = await fs.promises.readFile(path.join(this.dir, "chunks.jsonl"), "utf8");
      const buf = await fs.promises.readFile(path.join(this.dir, "vectors.bin"));

      this.metas = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChunkMeta);
      this.dim = head.dim;
      this.model = head.model;
      this.vecs = new Float32Array(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      );
      // 三个文件可能因为中途崩溃而不同步，对不上就整体作废重建
      if (this.vecs.length !== this.metas.length * this.dim) this.reset();
    } catch {
      this.reset();
    }
  }

  reset(): void {
    this.metas = [];
    this.vecs = new Float32Array(0);
    this.dim = 0;
  }

  setModel(model: string, dim: number): void {
    // 换了嵌入模型，旧向量不可比，必须全部作废
    if (this.model !== model || (this.dim && this.dim !== dim)) this.reset();
    this.model = model;
    this.dim = dim;
  }

  removePaths(paths: Set<string>): void {
    if (paths.size === 0) return;
    const keepIdx: number[] = [];
    const kept: ChunkMeta[] = [];
    this.metas.forEach((m, i) => {
      if (!paths.has(m.path)) {
        keepIdx.push(i);
        kept.push(m);
      }
    });
    if (kept.length === this.metas.length) return;
    const next = new Float32Array(kept.length * this.dim);
    keepIdx.forEach((src, dst) => {
      next.set(this.vecs.subarray(src * this.dim, (src + 1) * this.dim), dst * this.dim);
    });
    this.metas = kept;
    this.vecs = next;
  }

  add(metas: ChunkMeta[], vectors: Float32Array[]): void {
    if (metas.length === 0) return;
    const next = new Float32Array(this.vecs.length + metas.length * this.dim);
    next.set(this.vecs, 0);
    vectors.forEach((v, i) => next.set(v, this.vecs.length + i * this.dim));
    this.vecs = next;
    this.metas.push(...metas);
  }

  async save(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const head: StoreHeader = {
      version: 1,
      model: this.model,
      dim: this.dim,
      count: this.metas.length,
    };
    await fs.promises.writeFile(path.join(this.dir, "header.json"), JSON.stringify(head));
    await fs.promises.writeFile(
      path.join(this.dir, "chunks.jsonl"),
      this.metas.map((m) => JSON.stringify(m)).join("\n")
    );
    await fs.promises.writeFile(
      path.join(this.dir, "vectors.bin"),
      Buffer.from(this.vecs.buffer, this.vecs.byteOffset, this.vecs.byteLength)
    );
  }

  /** 归一化过的向量，点积即余弦相似度 */
  /**
   * 某个文件开头的前 n 段。
   *
   * 「这篇论文讲了什么」限定到单个文件后，语义检索命中的往往是结论和
   * 参考文献那几页——那些段落读起来最像「总结」。但用户要的是摘要。
   * 标题和摘要就在文件开头，直接按位置取，不参与打分。
   */
  headOf(path: string, n: number): Hit[] {
    const idx: number[] = [];
    for (let i = 0; i < this.metas.length; i++) {
      if (this.metas[i].path === path) idx.push(i);
    }
    // chunks 是按顺序写进去的，页码/行号小的在前
    idx.sort((a, b) => {
      const A = this.metas[a];
      const B = this.metas[b];
      return (A.page || 0) - (B.page || 0) || A.line - B.line;
    });
    return idx.slice(0, n).map((i) => ({ ...this.metas[i], score: 1 }));
  }

  /**
   * 字面检索。语义检索对罕见专有名词是盲区——实测「什么是 MOPD」
   * 最高分只有 0.439，低于 0.5 阈值，插件会回答「库里没有」，
   * 而库里其实有 3 段。「Dresdner Kleinwort」更是前 8 名一条都没命中。
   *
   * 打分用简化的 IDF：一个词出现在越少的段落里，命中它越值钱。
   * 不做分词——中文分词在浏览器里没有好用的实现，而真正需要字面检索的
   * 恰恰是 MOPD / MXFP4 / EAGLE-3 这类 ASCII 专有名词，直接 indexOf 就够。
   */
  keyword(terms: string[], topK: number, paths?: string[], since?: number): Hit[] {
    if (terms.length === 0) return [];
    const lower = terms.map((t) => t.toLowerCase());

    // 先数每个词的文档频率，用来算 IDF
    const df = new Array(lower.length).fill(0);
    const inScope: number[] = [];
    for (let i = 0; i < this.metas.length; i++) {
      const m = this.metas[i];
      if (paths?.length && !paths.some((p) => m.path.startsWith(p))) continue;
      if (since && m.mtime < since) continue;
      inScope.push(i);
      const text = m.text.toLowerCase();
      for (let t = 0; t < lower.length; t++) {
        if (text.includes(lower[t])) df[t]++;
      }
    }
    if (inScope.length === 0) return [];

    const idf = df.map((d) => (d === 0 ? 0 : Math.log(1 + inScope.length / d)));
    const scored: Hit[] = [];
    for (const i of inScope) {
      const text = this.metas[i].text.toLowerCase();
      let s = 0;
      for (let t = 0; t < lower.length; t++) {
        if (!idf[t]) continue;
        // 出现次数取对数：一段里重复十次不该比出现两次值钱五倍
        const n = countOf(text, lower[t]);
        if (n) s += idf[t] * (1 + Math.log(n));
      }
      if (s > 0) scored.push({ ...this.metas[i], score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** 某个文件某一页的全部段落，按顺序。「这页讲了什么」用它，不走相似度。 */
  pageOf(path: string, page: number): Hit[] {
    const out: Hit[] = [];
    for (const m of this.metas) {
      if (m.path === path && m.page === page) out.push({ ...m, score: 1 });
    }
    return out.sort((a, b) => a.line - b.line);
  }

  search(query: Float32Array, topK: number, threshold: number, paths?: string[], since?: number): Hit[] {
    if (this.metas.length === 0 || query.length !== this.dim) return [];
    const scored: Hit[] = [];
    for (let i = 0; i < this.metas.length; i++) {
      const m = this.metas[i];
      if (paths?.length && !paths.some((p) => m.path.startsWith(p))) continue;
      if (since && m.mtime < since) continue;
      let s = 0;
      const off = i * this.dim;
      for (let d = 0; d < this.dim; d++) s += this.vecs[off + d] * query[d];
      if (s >= threshold) scored.push({ ...m, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

function defaultRoot(): string {
  const home = os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "knowledge-ai");
  if (process.platform === "win32")
    return path.join(process.env.APPDATA ?? home, "knowledge-ai");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "knowledge-ai");
}

function sanitize(s: string): string {
  return s.replace(/[^\w一-鿿.-]+/g, "_").slice(0, 60) || "vault";
}
