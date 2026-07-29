import * as fs from "fs";
import { getUiLang, t } from "../i18n";
import * as path from "path";
import { TFile, Vault, requestUrl } from "obsidian";
import type { KnowledgeAiSettings } from "../settings";

/**
 * 给图片生成文字描述，好让它们进入语义索引。
 *
 * 这是「像飞书知识问答一样」的关键一环：问「笔记里有没有讲某个架构」时，
 * 那张 Excalidraw 图本身要能被召回，而不是只能搜到提到它的文字。
 *
 * 代价不小——一张图十几秒，几百张就是半小时起。所以默认关闭，
 * 开启前在设置里明确告知预计耗时，并且逐张缓存，重建索引时不会重来。
 */

/** 描述会进索引，语言要和用户检索时用的语言一致，否则永远召不回来 */
function prompt(): string {
  return getUiLang() === "zh"
    ? "用中文描述这张图的内容，供全文检索使用。写清楚：图里的文字（原样抄录）、" +
      "图表或示意图的结构与关系、以及它在讲什么主题。只输出描述本身，不要客套。"
    : "Describe this image in English for full-text search. Include: any text in the " +
      "image (transcribed verbatim), the structure and relationships in any diagram, " +
      "and what topic it covers. Output only the description.";
}

const MAX_SIDE = 768;   // 描述用途，768 够了，再大只是徒增耗时

export interface DescribeResult {
  text?: string;
  error?: string;
  cached?: boolean;
}

function cacheKey(file: TFile): string {
  const raw = `${file.path}|${file.stat.mtime}|${file.stat.size}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + "-" + file.stat.size.toString(36);
}

export async function describeImage(
  vault: Vault,
  file: TFile,
  settings: KnowledgeAiSettings,
  cacheDir: string
): Promise<DescribeResult> {
  const cached = path.join(cacheDir, cacheKey(file) + ".txt");
  try {
    return { text: await fs.promises.readFile(cached, "utf8"), cached: true };
  } catch {
    /* 未命中 */
  }

  const model = settings.visionModel || settings.chatModel;
  if (!model) return { error: t("error.noVisionModel") };

  let dataUrl: string;
  try {
    dataUrl = await toDataUrl(vault, file);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  try {
    const res = await requestUrl({
      url: settings.endpoint.replace(/\/+$/, "") + "/chat/completions",
      method: "POST",
      contentType: "application/json",
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
      body: JSON.stringify({
        model,
        max_tokens: 500,
        temperature: 0.2,
        reasoning_effort: "none",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt() },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
      }),
      throw: false,
    });
    if (res.status !== 200) return { error: `HTTP ${res.status}` };

    const text: string = (res.json?.choices?.[0]?.message?.content ?? "").trim();
    // 模型没收到图时会说「我看不到图片」——这种描述进索引就是污染
    if (text.length < 20 || /img-\d|占位符|无法.*看到|cannot see/i.test(text)) {
      return { error: t("error.imgNotSeen") };
    }

    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(cached, text, "utf8");
    } catch {
      /* 缓存失败不影响本次 */
    }
    return { text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 读成 data URL 并缩到 768，长边太大只会拖慢而无助于描述质量 */
async function toDataUrl(vault: Vault, file: TFile): Promise<string> {
  const buf = await vault.readBinary(file);
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const ext = file.extension.toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const raw = `data:${mime};base64,${btoa(bin)}`;

  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error(t("error.imgDecode")));
    img.src = raw;
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (scale >= 1) return raw;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return raw;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function isImage(f: TFile): boolean {
  return /^(png|jpe?g|webp|gif)$/i.test(f.extension);
}
