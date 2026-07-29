/**
 * 模型输出清洗。规则从 ~/bin/ai 搬过来——那边踩过的坑这边一样会踩。
 *
 * 各家的内部标记互不冲突，合并成一张表挨个剥：
 *  · Qwen3 系列默认开思考，会先吐一整段 <think>…</think> 的内心独白
 *  · Gemma 用 <|channel>thought…<channel|>
 *  · 工具调用语法永远不该出现在用户看到的文字里；正常流程会被解析掉，
 *    但模型偶尔会在普通回答里凭惯性吐出来，这里兜底
 */
const NOISE: RegExp[] = [
  /<think>[\s\S]*?(?:<\/think>|$)/g,                 // qwen3 等
  /<\|channel>thought[\s\S]*?(?:<channel\|>|$)/g,    // gemma
  /<\|tool_call>[\s\S]*?(?:<tool_call\|>|$)/g,       // gemma 格式的工具调用
  /<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g,         // qwen XML / JSON 格式
  /<\|\/?\w[^>]*\|?>/g,                              // 残留特殊 token
];

export function cleanOutput(text: string): string {
  let out = text;
  for (const rx of NOISE) out = out.replace(rx, "");
  return out.trim();
}

/**
 * 流式场景下的清洗器。思考块是跨 chunk 到达的，不能逐块 replace——
 * 必须缓冲到标记闭合为止，否则用户会看到半截 <think 闪过。
 */
export class StreamCleaner {
  private buf = "";
  private inThink = false;

  /** 喂入一段新 token，返回可以安全显示的部分（可能为空） */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";

    for (;;) {
      if (this.inThink) {
        const end = this.buf.search(/<\/think>|<channel\|>/);
        if (end === -1) {
          this.buf = this.buf.slice(-32);   // 只留可能含闭合标记的尾巴
          return out;
        }
        const m = /<\/think>|<channel\|>/.exec(this.buf)!;
        this.buf = this.buf.slice(end + m[0].length);
        this.inThink = false;
        continue;
      }

      const start = this.buf.search(/<think>|<\|channel>thought/);
      if (start === -1) {
        // 结尾可能是半个标记，留够长度等下一块
        const safe = Math.max(0, this.buf.length - 24);
        out += this.buf.slice(0, safe);
        this.buf = this.buf.slice(safe);
        return out;
      }
      out += this.buf.slice(0, start);
      const m = /<think>|<\|channel>thought/.exec(this.buf)!;
      this.buf = this.buf.slice(start + m[0].length);
      this.inThink = true;
    }
  }

  /** 流结束时把缓冲里剩下的吐出来 */
  flush(): string {
    if (this.inThink) {
      this.buf = "";
      return "";
    }
    const rest = cleanOutput(this.buf);
    this.buf = "";
    return rest;
  }
}
