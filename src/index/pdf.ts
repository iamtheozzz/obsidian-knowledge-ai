import * as fs from "fs";
import { t } from "../i18n";
import * as path from "path";
import { TFile, Vault } from "obsidian";

/**
 * PDF 文本提取。
 *
 * 用 Obsidian 自带的 pdf.js（它要渲染 PDF，本来就带了一份），
 * 不打包 pdfjs-dist，也不用自己配 worker —— 这是 pdf-plus 的做法，
 * 省下约 1 MB 体积，也绕开了「插件里加载 worker」这个最容易翻车的环节。
 */

/** 带 includeMarkedContent 时，items 里会混入标记事件，它们没有 str 只有 type。 */
interface TextItem {
  str?: string;
  hasEOL?: boolean;
  /** 变换矩阵，[4]=x [5]=y。用来把表单填写值放回它该在的位置。 */
  transform?: number[];
  type?: string;
  tag?: string;
}
interface PdfPage {
  getTextContent(opts?: { includeMarkedContent?: boolean }): Promise<{ items: TextItem[] }>;
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfJsLib {
  getDocument(opts: {
    data: ArrayBuffer;
    cMapUrl?: string;
    cMapPacked?: boolean;
    standardFontDataUrl?: string;
  }): { promise: Promise<PdfDoc> };
}

function lib(): PdfJsLib | null {
  const g = (window as unknown as { pdfjsLib?: PdfJsLib }).pdfjsLib;
  return g && typeof g.getDocument === "function" ? g : null;
}

export function pdfAvailable(): boolean {
  return lib() !== null;
}

/**
 * 这份 PDF 是不是没有文字层（扫描件、拍照件、手写笔记）。
 *
 * 判据是「去掉页码标记后平均每页还剩几个字符」。阈值刻意定得极低：
 * 真正的扫描件是精确的 0，而有些书正文是插图、每页只有稀疏图注，
 * 那点字仍然有用，不该被误杀。5 这条线只抓得到真扫描件。
 *
 * 页码标记是本文件自己加的（见 extractPdf），所以这个判断也放在这里——
 * 放到 indexer 里就得让它去猜标记长什么样，格式一改两边就对不上了。
 */
export function isScanned(text: string): boolean {
  const marks = text.match(/^\[第 \d+ 页\]$/gm)?.length ?? 0;
  const body = text.replace(/^\[第 \d+ 页\]$/gm, "").replace(/\s+/g, "");
  // 一页都没有的畸形文件交给别处处理，这里不下结论
  if (marks === 0) return false;
  return body.length / marks < 5;
}

/**
 * 提取逻辑的版本号。改了提取方式就要加一，否则老缓存会一直命中，
 * 修好的 bug 在已索引的文件上永远不生效——而那些恰恰是最需要重提的。
 */
const EXTRACT_VERSION = 2;

/** 缓存键含 mtime 和大小，文件变了自动重提。
 *  一本几百页的教材提取要几秒、产出上百万字符，每次索引都重来不可接受。 */
function cacheKey(file: TFile): string {
  const raw = `v${EXTRACT_VERSION}|${file.path}|${file.stat.mtime}|${file.stat.size}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + "-" + file.stat.size.toString(36);
}

export async function extractPdf(
  vault: Vault,
  file: TFile,
  cacheDir: string
): Promise<{ text: string; cached: boolean } | { error: string }> {
  const cached = path.join(cacheDir, cacheKey(file) + ".txt");
  try {
    return { text: await fs.promises.readFile(cached, "utf8"), cached: true };
  } catch {
    /* 未命中，继续提取 */
  }

  const pdfjs = lib();
  if (!pdfjs) return { error: t("error.noPdfjs") };

  let doc: PdfDoc | null = null;
  try {
    const buf = await vault.readBinary(file);
    doc = await pdfjs.getDocument({
      data: buf,
      // 中日韩字符要靠 cMap 才能正确还原，Obsidian 自带这套资源
      cMapUrl: "/lib/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/lib/pdfjs/standard_fonts/",
    }).promise;

    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent({ includeMarkedContent: true });
      // 页码标记必须独占一行：chunker 的 pageMap 靠 ^\[第 N 页\]$ 精确匹配
      parts.push(`[第 ${i} 页]`);
      parts.push(itemsToText(reflowForms(content.items)));
    }
    const text = parts.join("\n");

    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(cached, text, "utf8");
    } catch {
      /* 缓存写失败不影响本次结果 */
    }
    return { text, cached: false };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    await doc?.destroy().catch(() => undefined);
  }
}

/**
 * 把扁平化表单的填写值放回它对应的标签后面。
 *
 * 表格类 PDF（合同、申请表、政府表单）定稿时常把表单「压平」，填写值变成页面
 * 内容的一部分。但压平出来的那层是在 content stream 末尾统一画的，而 pdf.js
 * 严格按流顺序输出文字，于是所有填写值堆在页尾，和它们的标签彻底分家：
 *
 *   〔标签〕  第 3 条 —— 包含以下项目：
 *   〔模板〕  上述项目须在整个期限内保持可用。
 *   ……（整页其余模板文字）……
 *   〔填写值〕全部堆在这里，离各自的标签几十行远
 *
 * 检索上这是灾难——问「表里填了什么」，标签那段召回了也没有答案，
 * 值那段又是一串没有上下文的孤立名词，向量根本对不上。
 *
 * 好在压平层带 `/Tx` 标记（BMC，marked content），能被精确识别，所以不必去
 * 猜哪些文字是填写值。只把这些块按纵坐标插回「紧邻其上方的那一行」之后，
 * 页面其余文字的顺序一个字都不动——双栏排版的书籍因此完全不受影响，
 * 那种整页按坐标重排的做法会把左右栏搅在一起。
 */
export function reflowForms(items: TextItem[]): TextItem[] {
  const main: TextItem[] = [];
  const blocks: Array<{ items: TextItem[]; y: number | null }> = [];
  let cur: { items: TextItem[]; y: number | null } | null = null;

  for (const it of items) {
    if (it.type === "beginMarkedContent") {
      if (it.tag === "Tx") cur = { items: [], y: null };
      continue;
    }
    if (it.type === "endMarkedContent") {
      if (cur && cur.items.length) blocks.push(cur);
      cur = null;
      continue;
    }
    if (it.type) continue; // 其它标记事件，不是文字
    const y = it.transform?.[5];
    if (cur) {
      if (cur.y === null && y != null) cur.y = y;
      cur.items.push(it);
    } else {
      main.push(it);
    }
  }

  // 没有表单层就是普通 PDF，原样返回，不引入任何行为变化
  if (!blocks.length) return main;

  const ys = main.map((m) => m.transform?.[5] ?? null);
  const insert = new Map<number, Array<{ items: TextItem[]; y: number | null }>>();
  for (const b of blocks) {
    let at = 0;
    if (b.y != null) {
      // 找「在它上方、且离它最近」的那一行。不能取「最后一个 y 大于它的」——
      // 页脚生成信息之类的项排在流末尾却有很高的 y，会把插入点带到页尾。
      let target: number | null = null;
      for (const y of ys) {
        if (y != null && y >= b.y - Y_TOLERANCE && (target === null || y < target)) target = y;
      }
      if (target !== null) {
        for (let i = 0; i < ys.length; i++) if (ys[i] === target) at = i + 1;
      }
    }
    const list = insert.get(at);
    if (list) list.push(b);
    else insert.set(at, [b]);
  }

  const out: TextItem[] = [];
  for (let i = 0; i <= main.length; i++) {
    for (const b of insert.get(i) ?? []) {
      out.push(...b.items);
      // 补一个换行，免得填写值和下一行模板文字黏成一句
      out.push({ str: "", hasEOL: true });
    }
    if (i < main.length) out.push(main[i]);
  }
  return out;
}

/** 同一行的纵坐标可能有零点几的浮动，比较时留一点余量 */
const Y_TOLERANCE = 0.5;

/** pdf.js 给的是一堆文本片段，hasEOL 标记行尾。
 *  不处理换行的话整页会连成一行，切块时行号就全失去意义了。 */
function itemsToText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let out = "";
  for (const it of items) {
    out += it.str ?? "";
    if (it.hasEOL) out += "\n";
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** 清掉源文件已消失或已改动的缓存 */
export async function cleanPdfCache(cacheDir: string, live: Set<string>): Promise<number> {
  let removed = 0;
  try {
    for (const name of await fs.promises.readdir(cacheDir)) {
      if (!name.endsWith(".txt")) continue;
      if (live.has(name.slice(0, -4))) continue;
      await fs.promises.unlink(path.join(cacheDir, name)).catch(() => undefined);
      removed++;
    }
  } catch {
    /* 目录不存在 */
  }
  return removed;
}

export { cacheKey };
