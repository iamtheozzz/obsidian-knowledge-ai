import { t } from "./i18n";
import type { KnowledgeAiSettings } from "./settings";

export interface ChatMessage {
  role: string;
  content: string | unknown;
}

export interface StreamOptions {
  /** 覆盖 settings.chatModel，带图时用来切到视觉模型 */
  model?: string;
  maxTokens?: number;
  /** 显式指定上下文窗口。只有学到真值后重试时才传。 */
  numCtx?: number;
  /** 采样温度。分类这类要稳定输出的调用传 0。 */
  temperature?: number;
}

/**
 * 端点报错。带上解析出来的真实上下文窗口，调用方据此重试。
 *
 * 不要从 message 文本里反解这个数字——message 是要给用户看的，
 * 会被翻译成界面语言，用正则去匹配翻译结果，界面一换语言就静默失效。
 */
export class EndpointError extends Error {
  constructor(message: string, readonly ctx?: number) {
    super(message);
    this.name = "EndpointError";
  }
}

/**
 * 流式对话。全插件唯一一条出网路径——问答、追问改写、选中改写都走这里。
 *
 * 用 Node 的 http 而不是 Obsidian 的 requestUrl：后者不支持流式，
 * 而 fetch 在渲染进程里受 CORS 约束，端点是否放行取决于用户配置。
 * 插件本来就是 isDesktopOnly，用 Node 模块是可靠的做法。
 */
export function streamChat(
  settings: KnowledgeAiSettings,
  messages: ChatMessage[],
  signal: AbortSignal,
  onChunk: (text: string) => void,
  opts: StreamOptions = {}
): Promise<void> {
  // 需要指定上下文窗口时必须走 Ollama 原生端点。
  //
  // /v1/chat/completions（OpenAI 兼容层）会**静默忽略** options.num_ctx——
  // 请求返回 200，但窗口仍是默认的 4096。实测：4984 token 的请求发到 /v1
  // 带 num_ctx=32768 照样报 "exceeds the available context size (4096)"，
  // 同样的请求发到 /api/chat 就正常。
  //
  // 这个静默失败很毒：报错被 ctxCache 记成 4096，之后整个会话的材料预算
  // 被锁死在 2992 字符，召回 8 段只有 2 段真正送进模型。
  const nativeBase = ollamaBase(settings.endpoint);
  const useNative = Boolean(opts.numCtx && nativeBase);
  const url = new URL(
    useNative ? `${nativeBase}/api/chat` : settings.endpoint.replace(/\/+$/, "") + "/chat/completions"
  );

  const common = {
    model: opts.model ?? settings.chatModel,
    messages,
    stream: true,
  };
  const body = JSON.stringify(
    useNative
      ? {
          ...common,
          think: false,
          options: {
            temperature: opts.temperature ?? 0.3,
            // 原生端点用 num_predict，不是 max_tokens
            num_predict: opts.maxTokens ?? 2000,
            num_ctx: opts.numCtx,
          },
        }
      : {
          ...common,
          temperature: opts.temperature ?? 0.3,
          // 给够预算：带思考的模型（qwen3 等）会先花几百 token 想，
          // 卡在 400 会导致答案还没写完就被截断
          max_tokens: opts.maxTokens ?? 2000,
          // 关掉思考。检索场景下材料已经摆在眼前，思考带来的收益很小，
          // 代价却极大：实测 qwen3.5:9b 一句 57 字的回答烧掉 1207 个 token，
          // 预算一旦被思考吃光，content 会返回空字符串。
          // 不支持这个参数的端点会忽略它，是安全的。
          reasoning_effort: "none",
        }
  );

  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? require("https") : require("http");
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        },
      },
      (res: NodeJS.ReadableStream & { statusCode?: number }) => {
        if (res.statusCode && res.statusCode !== 200) {
          let err = "";
          res.on("data", (c: Buffer) => (err += c.toString()));
          res.on("end", () => {
            const p = parseErr(err);
            reject(new EndpointError(p.message ?? `HTTP ${res.statusCode}`, p.ctx));
          });
          return;
        }
        let buf = "";
        res.on("data", (c: Buffer) => {
          buf += c.toString("utf8");
          // SSE 以换行分帧，最后一段可能不完整，留着等下一块
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const s = line.trim();
            if (!s) continue;
            // 原生端点是行分隔 JSON；OpenAI 兼容层是 SSE 的 data: 前缀
            let payload = s;
            if (!useNative) {
              if (!s.startsWith("data:")) continue;
              payload = s.slice(5).trim();
              if (payload === "[DONE]") continue;
            }
            try {
              const j = JSON.parse(payload);
              const delta = useNative
                ? j?.message?.content
                : j?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) onChunk(delta);
            } catch {
              /* 半截 JSON，跳过 */
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    signal.addEventListener("abort", () => req.destroy(), { once: true });
    req.write(body);
    req.end();
  });
}

/**
 * 认出 Ollama 并给出它的原生根地址。
 * 只认 /v1 结尾的地址——那是 Ollama 的 OpenAI 兼容层的固定形态。
 * 认不出就返回 null，走标准 OpenAI 协议（云端点、mlx_lm.server 等）。
 */
function ollamaBase(endpoint: string): string | null {
  const e = endpoint.replace(/\/+$/, "");
  return /\/v1$/.test(e) ? e.replace(/\/v1$/, "") : null;
}

/** 各家端点错误结构不一，尽量把人话捞出来；Ollama 还会多包一层 JSON */
export function parseErr(text: string): { message: string | null; ctx?: number } {
  try {
    const j = JSON.parse(text);
    let msg: string = j?.error?.message ?? j?.error ?? "";
    if (typeof msg === "string" && msg.trim().startsWith("{")) {
      try {
        msg = JSON.parse(msg)?.error?.message ?? msg;
      } catch {
        /* 保持原样 */
      }
    }
    // 上下文超限是最常见的一类失败：从 HuggingFace 直接拉的 GGUF
    // 在 Ollama 上默认只给 4096 窗口，塞进检索材料必然超。
    // 原文是英文 JSON，用户完全看不懂，翻成人话并给出下一步。
    const m = /(\d+)\s*tokens\).*?context size \((\d+)/.exec(msg);
    if (m) {
      return {
        message: t("error.ctxOverflow", { ctx: m[2], need: m[1] }),
        ctx: Number(m[2]),
      };
    }
    const n = /"n_ctx":\s*(\d+)/.exec(msg);
    return { message: msg || null, ctx: n ? Number(n[1]) : undefined };
  } catch {
    return { message: null };
  }
}

/** 从任意异常里读出真实上下文窗口，读不出返回 null */
export function ctxFromError(e: unknown): number | null {
  if (e instanceof EndpointError && e.ctx) return e.ctx;
  return null;
}
