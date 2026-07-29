export interface Chunk {
  text: string;
  line: number;    // 1-based，块的起始行
  page: number;    // PDF 用，非 PDF 为 0
}

// 与 ~/bin/ai 实测下来的参数保持一致
export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 150;
const MIN_CHUNK = 30;

/**
 * 按行累积到 CHUNK_CHARS 就切一块，并回退 CHUNK_OVERLAP 个字符作为重叠，
 * 避免正好把一个概念切成两半。每块记住起始行号，检索结果才能给出可核对的出处。
 */
export function chunkText(body: string, pageOf?: (lineIdx: number) => number): Chunk[] {
  const lines = body.split("\n");
  const out: Chunk[] = [];
  let buf: string[] = [];
  let bufStart = 1;
  let size = 0;

  const flush = (startLine: number) => {
    const text = buf.join("\n").trim();
    if (text.length > MIN_CHUNK) {
      out.push({ text, line: startLine, page: pageOf ? pageOf(startLine - 1) : 0 });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    buf.push(lines[i]);
    size += lines[i].length + 1;
    if (size < CHUNK_CHARS) continue;

    flush(bufStart);

    // 回退若干行做重叠
    const keep: string[] = [];
    let kept = 0;
    for (let j = buf.length - 1; j >= 0 && kept < CHUNK_OVERLAP; j--) {
      keep.unshift(buf[j]);
      kept += buf[j].length + 1;
    }
    buf = keep;
    bufStart = i + 2 - buf.length;
    size = kept;
  }
  flush(bufStart);
  return out;
}

/** PDF 提取文本里插了 [第 N 页] 标记，据此算出每行属于第几页。M4 用。 */
export function pageMap(body: string): (lineIdx: number) => number {
  const re = /^\[第 (\d+) 页\]$/;
  const pages: number[] = [];
  let cur = 0;
  for (const ln of body.split("\n")) {
    const m = re.exec(ln);
    if (m) cur = parseInt(m[1], 10);
    pages.push(cur);
  }
  return (i) => pages[Math.max(0, Math.min(i, pages.length - 1))] ?? 0;
}
