import zh from "./zh";
import en from "./en";

export type Locale = "zh" | "en";
export type UiLangSetting = "auto" | Locale;
export type AnswerLangSetting = "auto" | Locale;

const PACKS: Record<Locale, Record<string, string>> = { zh, en };

let current: Locale = "en";

/** Obsidian 把界面语言存在 localStorage 里，键名是 "language"。
 *  取不到就退回 en——对国际用户是更安全的默认。 */
function detectObsidianLocale(): Locale {
  try {
    const raw = window.localStorage.getItem("language") ?? "";
    return raw.startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

export function setUiLang(setting: UiLangSetting): Locale {
  current = setting === "auto" ? detectObsidianLocale() : setting;
  return current;
}

export function getUiLang(): Locale {
  return current;
}

/** 取一条文案。{name} 占位符按 vars 替换。
 *  缺键时返回键名本身而不是空字符串——界面上一眼能看出漏了哪条。 */
export function t(key: keyof typeof zh, vars?: Record<string, string | number>): string {
  const s = PACKS[current][key] ?? PACKS.en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** 判断一段文本主要是不是中文，用于「回答语言：跟随提问」。
 *  阈值取 10%：中文夹杂英文术语很常见，反过来很少。 */
export function looksChinese(text: string): boolean {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  return cjk > 0 && cjk / Math.max(text.length, 1) > 0.1;
}

export function resolveAnswerLang(setting: AnswerLangSetting, question: string): Locale {
  if (setting !== "auto") return setting;
  return looksChinese(question) ? "zh" : "en";
}
