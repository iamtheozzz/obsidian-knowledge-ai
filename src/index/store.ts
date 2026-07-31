import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizePath } from "obsidian";
import { isIgnored, normalizeIgnoreList } from "./ignore";

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
/** 模糊匹配的护栏。每一条都是为了防止它变成「什么都能匹配」 */
const FUZZY_MIN_COVERAGE = 0.7;   // 片段覆盖率低于此不算命中
const FUZZY_MIN_GRAMS = 3;        // 切不出三个片段的词太短，不做模糊
const FUZZY_MAX_TERMS = 3;        // 最多几条词走模糊，每条都要再扫一遍全库
const FUZZY_DF_TRIGGER = 2;       // 精确命中多于这个数就说明字面检索够用了
const FUZZY_MAX_DF_RATIO = 0.05;  // 命中超过全库 5% 说明没有区分度，丢弃
const FUZZY_WEIGHT = 0.7;         // 模糊命中相对精确命中的折价

/**
 * 把词切成用于模糊比对的片段。
 *
 * 中文按相邻二元组：改一个字只会破坏跨过它的那两个二元组，其余照常命中，
 * 「变强的唯一路径是心不受力」对「变强的唯一路径：心不受力」能到 0.82 覆盖率。
 * ASCII 按单词切——那类词的变体是词序和连接符差异，不是字符差异。
 */
function gramsOf(term: string): string[] {
  const s = term.toLowerCase().trim();
  if (/^[\x20-\x7e]+$/.test(s)) {
    return [...new Set(s.split(/[^a-z0-9]+/).filter((w) => w.length >= 2))];
  }
  // 标点在复述时最不稳定（全角半角、有无顿号），先去掉再切
  const c = s.replace(/[\s\p{P}\p{S}]+/gu, "");
  const out: string[] = [];
  for (let i = 0; i + 2 <= c.length; i++) out.push(c.slice(i, i + 2));
  return [...new Set(out)];
}

export class IndexStore {
  private dir: string;
  private metas: ChunkMeta[] = [];
  private vecs: Float32Array = new Float32Array(0);
  private dim = 0;
  private model = "";

  /** 忽略规则的副本。查询期兜底过滤用，由 main 在设置变动时同步进来。 */
  private ignored: string[] = [];

  constructor(vaultName: string, customDir: string) {
    const fallback = path.join(defaultRoot(), sanitize(vaultName));
    // 用户手填的路径先过 normalizePath：官方指南要求用它清理用户输入的路径，
    // 它会统一分隔符、去掉多余的斜杠和首尾空白。~ 要在那之前展开——
    // normalizePath 不认识它，留着会变成一个名叫 "~" 的目录。
    const raw = customDir.trim().replace(/^~(?=$|[/\\])/, os.homedir());
    if (!raw) {
      this.dir = fallback;
      return;
    }
    // 相对路径一律拒绝。原来这里直接 path.resolve()，而 Obsidian 进程的
    // 工作目录是 "/"，于是「llm/llm_test」被解析成「/llm/llm_test」——
    // macOS 的根分区只读，这个目录永远建不出来，索引写到第 30 篇就 EROFS 崩掉，
    // 界面上看起来却像「库里只有 30 篇笔记」。宁可退回默认位置，
    // 也不要生成一个用户根本没打算指定的路径。
    if (!path.isAbsolute(raw)) {
      this.dir = fallback;
      this.dirError = raw;
      return;
    }
    this.dir = path.resolve(normalizePath(raw));
  }

  /** 填了但不合法的存储路径。设置页要据此提示，否则用户不知道自己填的被忽略了 */
  dirError: string | null = null;

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

  /**
   * 存储目录能不能建、能不能写。
   *
   * 索引跑到一半才发现路径不可写是最糟的失败方式：几十分钟的嵌入白算，
   * 而且已经写进内存的删除操作可能已经落盘。开跑前先探一次，
   * 让错误出现在用户刚点下按钮的时候。
   */
  async checkWritable(): Promise<string | null> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const probe = path.join(this.dir, ".write-probe");
      await fs.promises.writeFile(probe, "");
      await fs.promises.unlink(probe);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
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
  /**
   * 同步忽略规则。
   *
   * 只把「不在索引里」当作忽略手段是不够的：文件可能在规则生效前就已入库，
   * 也可能因为改名、编辑而重新进来，而这些情况从设置页上完全看不出来。
   * 所以查询期再挡一道——这里是所有检索的唯一出口，挡在这里就漏不掉。
   */
  setIgnored(folders: string[]): void {
    this.ignored = normalizeIgnoreList(folders ?? []);
  }

  private blocked(p: string): boolean {
    return this.ignored.length > 0 && isIgnored(p, this.ignored);
  }

  headOf(path: string, n: number): Hit[] {
    if (this.blocked(path)) return [];
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
   * 字面检索。语义检索对罕见专有名词是盲区——实测问一个四字母缩写时
   * 最高分只有 0.439，低于 0.5 阈值，插件会回答「库里没有」，
   * 而库里其实有 3 段。一个不常见的机构名更是前 8 名一条都没命中。
   *
   * 打分用简化的 IDF：一个词出现在越少的段落里，命中它越值钱。
   * 不做分词——中文分词在浏览器里没有好用的实现，而真正需要字面检索的
   * 恰恰是缩写、型号、代号这类 ASCII 专有名词，直接 indexOf 就够。
   *
   * 精确匹配一条都没中的长词会再走一次模糊匹配。起因是用户复述标题时
   * 极少一字不差：问「变强的唯一路径是心不受力」，原文写的是
   * 「变强的唯一路径：心不受力」——只差一个字，indexOf 全军覆没。
   * 只对 df=0 的词启用，所以正常情况下没有任何额外开销。
   */
  keyword(terms: string[], topK: number, paths?: string[], since?: number): Hit[] {
    if (terms.length === 0) return [];
    const lower = terms.map((t) => t.toLowerCase());

    // 先数每个词的文档频率，用来算 IDF
    const df = new Array(lower.length).fill(0);
    const inScope: number[] = [];
    for (let i = 0; i < this.metas.length; i++) {
      const m = this.metas[i];
      if (this.blocked(m.path)) continue;
      if (paths?.length && !paths.some((p) => m.path.startsWith(p))) continue;
      if (since && m.mtime < since) continue;
      inScope.push(i);
      const text = m.text.toLowerCase();
      for (let t = 0; t < lower.length; t++) {
        if (text.includes(lower[t])) df[t]++;
      }
    }
    if (inScope.length === 0) return [];

    // 模糊兜底：救精确匹配几乎没命中的长词。
    // 判据不能写成 df==0——库里只要有一处一字不差地引用过（比如自己那份
    // 摘抄），df 就是 1，兜底永远不触发，而真正想找的原文照样漏掉。
    // 限制并发条数是为了兜住最坏情况：每条都要再扫一遍全库。
    const fuzzy = new Map<number, { grams: string[]; cov: Map<number, number>; df: number }>();
    for (let t = 0; t < lower.length && fuzzy.size < FUZZY_MAX_TERMS; t++) {
      if (df[t] > FUZZY_DF_TRIGGER) continue;
      const g = gramsOf(lower[t]);
      if (g.length < FUZZY_MIN_GRAMS) continue;   // 太短的词模糊化只会制造噪音
      fuzzy.set(t, { grams: g, cov: new Map(), df: 0 });
    }
    if (fuzzy.size) {
      for (const i of inScope) {
        const text = this.metas[i].text.toLowerCase();
        for (const [t, f] of fuzzy) {
          let hit = 0;
          for (const g of f.grams) if (text.includes(g)) hit++;
          const c = hit / f.grams.length;
          if (c >= FUZZY_MIN_COVERAGE) {
            f.cov.set(i, c);
            f.df++;
          }
        }
      }
      // 一个片段几乎处处都在（比如全是常见字）说明这个词模糊化之后
      // 已经没有区分度，整条丢掉，免得把半个库都拉进来
      for (const [t, f] of fuzzy) {
        if (f.df === 0 || f.df > inScope.length * FUZZY_MAX_DF_RATIO) fuzzy.delete(t);
      }
    }

    const idf = lower.map((_, t) => {
      const d = df[t] || fuzzy.get(t)?.df || 0;
      return d === 0 ? 0 : Math.log(1 + inScope.length / d);
    });
    const scored: Hit[] = [];
    for (const i of inScope) {
      const text = this.metas[i].text.toLowerCase();
      let s = 0;
      for (let t = 0; t < lower.length; t++) {
        if (!idf[t]) continue;
        // 出现次数取对数：一段里重复十次不该比出现两次值钱五倍
        const n = countOf(text, lower[t]);
        let w = n ? 1 + Math.log(n) : 0;
        // 模糊命中按覆盖率折价，再整体压一档：同一段里两者都成立时取较大的，
        // 精确命中不该因为顺带算了一次模糊而被压低
        const c = fuzzy.get(t)?.cov.get(i);
        if (c) w = Math.max(w, c * FUZZY_WEIGHT);
        if (w) s += idf[t] * w;
      }
      if (s > 0) scored.push({ ...this.metas[i], score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** 某个文件某一页的全部段落，按顺序。「这页讲了什么」用它，不走相似度。 */
  pageOf(path: string, page: number): Hit[] {
    if (this.blocked(path)) return [];
    const out: Hit[] = [];
    for (const m of this.metas) {
      if (m.path === path && m.page === page) out.push({ ...m, score: 1 });
    }
    return out.sort((a, b) => a.line - b.line);
  }

  /**
   * @param notesOnly 只在库内笔记里检索，不看 PDF。
   *   给召回侧留一条专用通道：PDF 通常占索引的绝大多数，混排取窗口时
   *   笔记会被整体挤掉，后面再谈「给笔记留名额」已经无米下锅。
   */
  search(
    query: Float32Array, topK: number, threshold: number,
    paths?: string[], since?: number, notesOnly?: boolean
  ): Hit[] {
    if (this.metas.length === 0 || query.length !== this.dim) return [];
    const scored: Hit[] = [];
    for (let i = 0; i < this.metas.length; i++) {
      const m = this.metas[i];
      if (this.blocked(m.path)) continue;
      if (notesOnly && /\.pdf$/i.test(m.path)) continue;
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
