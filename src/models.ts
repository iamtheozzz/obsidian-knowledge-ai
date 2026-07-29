import { requestUrl } from "obsidian";
import { t } from "./i18n";
import type { KnowledgeAiSettings } from "./settings";

export interface ModelInfo {
  id: string;
  tools?: boolean;      // 仅在能拿到能力标签时有值
  vision?: boolean;
  params?: number;      // 参数量，用来在下拉里提示模型大小
  context?: number;     // 上下文长度，太小的装不下检索材料
}

/** 检索后要塞进去的材料约 4K token，再留出回答空间。
 *  低于这个数的模型选了也答不出东西，直接不列。 */
const MIN_CONTEXT = 8192;

export function modelLabel(m: ModelInfo): string {
  const bits: string[] = [];
  if (m.params) bits.push(`${(m.params / 1e9).toFixed(1)}B`);
  if (m.vision) bits.push("vision");
  if (m.tools) bits.push("tools");
  return bits.length ? `${m.id}  ·  ${bits.join("  ·  ")}` : m.id;
}

/** 只探测嵌入端点上的模型。对话端点和嵌入端点可能不是同一处。 */
export async function listEmbedModels(s: KnowledgeAiSettings): Promise<ModelInfo[]> {
  if (!s.embedEndpoint) return [];      // 同一端点时由 listModels 一并给出
  const base = embedBase(s);
  try {
    const res = await requestUrl({
      url: base + "/models",
      method: "GET",
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      throw: false,
    });
    if (res.status !== 200) return [];
    const data = res.json?.data;
    if (!Array.isArray(data)) return [];
    const ids: string[] = data.map((m: { id: string }) => m.id).filter(Boolean).sort();
    const root = base.replace(/\/v1$/, "");
    const caps = await Promise.all(ids.map((id) => detail(root, id)));
    const out: ModelInfo[] = [];
    ids.forEach((id, i) => {
      const d = caps[i];
      if (d === null || d.caps.includes("embedding")) out.push({ id, params: d?.params });
    });
    return out;
  } catch {
    return [];
  }
}

export interface ModelList {
  chat: ModelInfo[];
  vision: ModelInfo[];
  embed: ModelInfo[];
  /** 拿到了逐个模型的能力标签（目前只有 Ollama 提供），
   *  false 表示只能拿到一个扁平列表，两个下拉里都放全部 */
  enriched: boolean;
  error?: string;
}

/**
 * 探测端点上有哪些模型可用。
 *
 * 两层：
 *  1. /v1/models —— OpenAI 兼容规范的一部分，任何端点都该有，但只给 id
 *  2. /api/show —— Ollama 专有，能给出 capabilities（completion / embedding / tools），
 *     据此把模型分到「对话」和「嵌入」两个下拉里，而不是让用户从一锅粥里挑
 */
/** 嵌入端点留空时跟随对话端点 */
export function embedBase(s: KnowledgeAiSettings): string {
  return (s.embedEndpoint || s.endpoint).replace(/\/+$/, "");
}

export async function listModels(s: KnowledgeAiSettings): Promise<ModelList> {
  const base = s.endpoint.replace(/\/+$/, "");
  let ids: string[];
  try {
    const res = await requestUrl({
      url: base + "/models",
      method: "GET",
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      throw: false,
    });
    if (res.status !== 200) return empty(`HTTP ${res.status}`);
    const data = res.json?.data;
    if (!Array.isArray(data)) return empty(t("error.badResponse"));
    ids = data.map((m: { id: string }) => m.id).filter(Boolean).sort();
  } catch {
    return empty(t("error.connectFailed"));
  }
  if (ids.length === 0) return empty(t("error.noModels"));

  // Ollama 的 /api/show 在 /v1 的上一层
  const ollamaRoot = base.replace(/\/v1$/, "");
  const caps = await Promise.all(ids.map((id) => detail(ollamaRoot, id)));

  if (caps.every((c) => c === null)) {
    // 拿不到能力标签：两个下拉都放全部，让用户自己判断
    const all = ids.map((id) => ({ id }));
    return { chat: all, embed: all, vision: all, enriched: false };
  }

  const chat: ModelInfo[] = [];
  const embed: ModelInfo[] = [];
  const vision: ModelInfo[] = [];
  const tooSmall: string[] = [];
  ids.forEach((id, i) => {
    const d = caps[i];
    if (d === null) {
      // 个别拿不到就两边都放，总比漏掉强
      chat.push({ id });
      embed.push({ id });
      vision.push({ id });
      return;
    }
    if (d.caps.includes("embedding")) embed.push({ id, params: d.params });
    if (d.caps.includes("completion")) {
      // 上下文装不下检索材料的，列出来也是坑用户
      if (d.context !== undefined && d.context < MIN_CONTEXT) {
        tooSmall.push(id);
        return;
      }
      const info: ModelInfo = {
        id,
        tools: d.caps.includes("tools"),
        vision: d.caps.includes("vision"),
        params: d.params,
        context: d.context,
      };
      chat.push(info);
      // 能力标签只是声明，实际能不能收到图片要靠「测试」按钮验——
      // Ollama 的 MLX 后端就标着 vision 却收不到图
      if (info.vision) vision.push(info);
    }
  });
  const note = tooSmall.length
    ? `已隐藏 ${tooSmall.length} 个上下文过小的模型：${tooSmall.join(", ")}`
    : undefined;
  return { chat, embed, vision, enriched: true, error: note };
}

interface Detail {
  caps: string[];
  params?: number;
  context?: number;
}

async function detail(root: string, model: string): Promise<Detail | null> {
  try {
    const res = await requestUrl({
      url: root + "/api/show",
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ model }),
      throw: false,
    });
    if (res.status !== 200) return null;
    const caps = res.json?.capabilities;
    if (!Array.isArray(caps)) return null;
    const mi: Record<string, unknown> = res.json?.model_info ?? {};
    // 上下文长度的键名带架构前缀（llama.context_length / qwen3.context_length …），
    // 挨个架构写死不现实，按后缀找
    const ctxKey = Object.keys(mi).find((k) => k.endsWith("context_length"));
    return {
      caps: caps as string[],
      params: numberOf(mi["general.parameter_count"]),
      context: ctxKey ? numberOf(mi[ctxKey]) : undefined,
    };
  } catch {
    return null;
  }
}

function numberOf(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}

function empty(error: string): ModelList {
  return { chat: [], embed: [], vision: [], enriched: false, error };
}
