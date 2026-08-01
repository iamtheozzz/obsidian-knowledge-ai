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

interface PdfPage {
  getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
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

/** 缓存键含 mtime 和大小，文件变了自动重提。
 *  一本几百页的教材提取要几秒、产出上百万字符，每次索引都重来不可接受。 */
function cacheKey(file: TFile): string {
  const raw = `${file.path}|${file.stat.mtime}|${file.stat.size}`;
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
      const content = await page.getTextContent();
      // 页码标记必须独占一行：chunker 的 pageMap 靠 ^\[第 N 页\]$ 精确匹配
      parts.push(`[第 ${i} 页]`);
      parts.push(itemsToText(content.items));
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
