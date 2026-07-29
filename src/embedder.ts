import { requestUrl } from "obsidian";
import { t } from "./i18n";

/** 端点侧的嵌入。走 OpenAI 兼容的 /embeddings，Ollama、LM Studio、云 API 都认。
 *  用 Obsidian 的 requestUrl 而不是 fetch —— 它不受渲染进程的 CORS 限制。 */
export class Embedder {
  constructor(
    private endpoint: string,
    readonly model: string,
    private apiKey: string
  ) {}

  private url(): string {
    return this.endpoint.replace(/\/+$/, "") + "/embeddings";
  }

  /** 一次嵌一批。批越大越省往返，但太大容易撞端点的请求体上限。 */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await requestUrl({
      url: this.url(),
      method: "POST",
      contentType: "application/json",
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      body: JSON.stringify({ model: this.model, input: texts }),
      throw: false,
    });

    if (res.status !== 200) {
      throw new EmbedError(res.status, extractMessage(res.text) ?? res.text.slice(0, 300));
    }
    const data = res.json?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbedError(res.status, t("error.dimMismatch"));
    }
    // 按 index 排序：规范允许乱序返回
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d: { embedding: number[] }) => normalize(d.embedding));
  }

  /** 测试用：跑一小批，回报维度和吞吐 */
  async probe(): Promise<{ dim: number; ratePerSec: number }> {
    const sample = "The quick brown fox. 一段用于测试嵌入吞吐的中英混合文本。".repeat(6);
    const batch = new Array(8).fill(sample);
    const t0 = performance.now();
    const vecs = await this.embed(batch);
    const dt = (performance.now() - t0) / 1000;
    return { dim: vecs[0]?.length ?? 0, ratePerSec: batch.length / Math.max(dt, 0.001) };
  }
}

export class EmbedError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "EmbedError";
  }
}

/** 归一化后检索时点积即余弦相似度，省掉每次查询的除法 */
function normalize(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** 各家端点的错误结构不一样，尽量把人话捞出来 */
export function extractMessage(text: string): string | null {
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? j?.error ?? j?.message ?? null;
  } catch {
    return null;
  }
}
