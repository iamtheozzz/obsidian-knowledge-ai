import { requestUrl, TFile, Vault } from "obsidian";
import { Embedder, extractMessage } from "./embedder";
import { embedBase } from "./models";
import { t } from "./i18n";
import type { KnowledgeAiSettings } from "./settings";
import { extractPdf, pdfAvailable } from "./index/pdf";

export interface TestResult {
  ok: boolean;
  text: string;
}

/** 对话端点自检：发一个极短请求，量首字延迟和吞吐，顺带探工具调用支持。 */
export async function testChat(s: KnowledgeAiSettings): Promise<TestResult> {
  if (!s.endpoint) return { ok: false, text: t("error.noEndpoint") };
  if (!s.chatModel) return { ok: false, text: t("error.modelNotFound", { model: "-" }) };

  const url = s.endpoint.replace(/\/+$/, "") + "/chat/completions";
  const t0 = performance.now();
  let res;
  try {
    res = await requestUrl({
      url,
      method: "POST",
      contentType: "application/json",
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      body: JSON.stringify({
        model: s.chatModel,
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
        max_tokens: 16,
      }),
      throw: false,
    });
  } catch (e) {
    return { ok: false, text: t("error.refused", { url: s.endpoint }) };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, text: t("error.auth") };
  if (res.status === 404)
    return { ok: false, text: t("error.modelNotFound", { model: s.chatModel }) };
  if (res.status !== 200) {
    return { ok: false, text: extractMessage(res.text) ?? `HTTP ${res.status}` };
  }

  const elapsed = (performance.now() - t0) / 1000;
  const content: string = res.json?.choices?.[0]?.message?.content ?? "";
  const used: number = res.json?.usage?.completion_tokens ?? content.length / 4;

  return {
    ok: true,
    text: t("test.chat.ok", {
      model: s.chatModel,
      ttft: elapsed.toFixed(1),
      tps: Math.round(used / Math.max(elapsed, 0.01)),
      tools: (await supportsTools(url, s)) ? t("test.chat.toolsYes") : t("test.chat.toolsNo"),
    }),
  };
}

/** 端点会直接拒绝不支持工具的模型，用这个判断比猜可靠 */
async function supportsTools(url: string, s: KnowledgeAiSettings): Promise<boolean> {
  try {
    const res = await requestUrl({
      url,
      method: "POST",
      contentType: "application/json",
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      body: JSON.stringify({
        model: s.chatModel,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        tools: [
          {
            type: "function",
            function: {
              name: "noop",
              description: "does nothing",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
      throw: false,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 嵌入自检：量维度和吞吐，并据此估算索引整库要多久。 */
export async function testEmbed(
  s: KnowledgeAiSettings,
  estimatedChunks: number
): Promise<TestResult> {
  if (!s.embedModel) return { ok: false, text: t("error.modelNotFound", { model: "-" }) };
  const emb = new Embedder(embedBase(s), s.embedModel, s.apiKey);
  try {
    const { dim, ratePerSec } = await emb.probe();
    const minutes = Math.max(1, Math.round(estimatedChunks / Math.max(ratePerSec, 0.1) / 60));
    return {
      ok: true,
      text:
        t("test.embed.ok", {
          model: s.embedModel,
          backend: "endpoint",
          dim,
          rate: ratePerSec.toFixed(1),
        }) +
        " · " +
        t("test.embed.estimate", { minutes }),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: msg };
  }
}


/**
 * PDF 自检。光看 window.pdfjsLib 存不存在不够——
 * 真正会翻车的是「存在但提不出文字」（扫描件、加密、字体缺失），
 * 所以拿库里最小的一个 PDF 实际跑一遍，用结果说话。
 */
export async function testPdf(
  vault: Vault,
  cacheDir: string
): Promise<TestResult> {
  if (!pdfAvailable()) {
    return { ok: false, text: t("test.pdf.unavailable") };
  }
  const pdfs = vault.getFiles().filter((f: TFile) => f.extension.toLowerCase() === "pdf");
  if (pdfs.length === 0) {
    return { ok: true, text: t("test.pdf.none") };
  }

  // 先拿最小的那个预热：pdf.js 首次调用要加载 worker、字体和 cmaps，
  // 这份一次性开销跟文件大小无关，算进样本会让速率估算低一个数量级。
  const sorted = [...pdfs].sort((a, b) => a.stat.size - b.stat.size);
  const warm = await extractPdf(vault, sorted[0], cacheDir);
  if ("error" in warm) {
    return { ok: false, text: t("test.pdf.failed", { name: sorted[0].name, msg: warm.error }) };
  }

  // 用中位大小的文件测速率，比最小或最大的都更有代表性
  const sample = sorted[Math.floor(sorted.length / 2)];
  const t0 = performance.now();
  const r = await extractPdf(vault, sample, cacheDir);
  const secs = (performance.now() - t0) / 1000;

  if ("error" in r) {
    return { ok: false, text: t("test.pdf.failed", { name: sample.name, msg: r.error }) };
  }
  const chars = r.text.replace(/\[第 \d+ 页\]/g, "").trim().length;
  const warmChars = "text" in warm ? warm.text.replace(/\[第 \d+ 页\]/g, "").trim().length : 0;
  // 两个样本都提不出字才判定为扫描件——单个文件可能本来就是空白页或纯图表
  if (chars < 50 && warmChars < 50) {
    return { ok: false, text: t("test.pdf.empty", { name: sample.name }) };
  }

  // 按字节比例外推整库耗时。缓存命中时这个数没意义，标注一下
  const totalBytes = pdfs.reduce((a, f) => a + f.stat.size, 0);
  const rate = sample.stat.size / Math.max(secs, 0.05);   // 预热后的净速率
  const minutes = Math.max(1, Math.round(totalBytes / rate / 60));
  return {
    ok: true,
    text: t("test.pdf.ok", {
      n: pdfs.length,
      name: trimName(sample.name),
      chars: chars.toLocaleString(),
      secs: secs.toFixed(1),
    }) + (r.cached ? t("test.pdf.cached") : t("test.pdf.estimate", { minutes })),
  };
}


/** 截断文件名但保留扩展名，避免出现「xxx.pd」这种半截后缀 */
function trimName(name: string, max = 26): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  return name.slice(0, Math.max(1, max - ext.length - 1)) + "…" + ext;
}


/**
 * 视觉自检。能力标签不可信 —— Ollama 的 MLX 后端标着 vision，
 * 实际收到的却是 [img-0] 占位符。所以必须真发一张图，
 * 看模型能不能说出图里的内容。
 */
export async function testVision(s: KnowledgeAiSettings): Promise<TestResult> {
  const model = s.visionModel || s.chatModel;
  if (!model) return { ok: false, text: t("error.modelNotFound", { model: "-" }) };

  // 现画一张图：一个红色圆 + 文字 VX7，不依赖任何打包资源
  const canvas = document.createElement("canvas");
  canvas.width = 220;
  canvas.height = 120;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, text: "canvas 不可用" };
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 220, 120);
  ctx.fillStyle = "#e03131";
  ctx.beginPath();
  ctx.arc(55, 60, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#000000";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText("VX7", 110, 75);
  const dataUrl = canvas.toDataURL("image/png");

  const t0 = performance.now();
  let res;
  try {
    res = await requestUrl({
      url: s.endpoint.replace(/\/+$/, "") + "/chat/completions",
      method: "POST",
      contentType: "application/json",
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      body: JSON.stringify({
        model,
        max_tokens: 300,
        reasoning_effort: "none",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "图里有什么形状和文字？只用一句话回答。" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
      }),
      throw: false,
    });
  } catch {
    return { ok: false, text: t("error.refused", { url: s.endpoint }) };
  }
  if (res.status !== 200) {
    return { ok: false, text: extractMessage(res.text) ?? `HTTP ${res.status}` };
  }

  const secs = (performance.now() - t0) / 1000;
  const answer: string = res.json?.choices?.[0]?.message?.content ?? "";

  // 模型能读出图里的 VX7 才算真收到了图片
  if (/VX7/i.test(answer)) {
    return { ok: true, text: t("test.vision.ok", { model, secs: secs.toFixed(1) }) };
  }
  // 说自己看不到图 / 提到占位符 —— 典型的后端不支持图片输入
  if (/img-\d|占位符|placeholder|无法.*(看到|识别)|cannot see|don't see/i.test(answer)) {
    return { ok: false, text: t("test.vision.placeholder", { model }) };
  }
  return { ok: false, text: t("test.vision.wrong", { model, answer: answer.slice(0, 60) }) };
}
