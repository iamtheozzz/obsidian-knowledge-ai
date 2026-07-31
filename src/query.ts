/**
 * 从问题里抽出「值得字面匹配的词」和「时间范围」。
 *
 * 都是确定性的规则，不问模型——这类判断给模型做既慢又不稳，
 * 而且没法回归测试。和「这篇/这页」的指代识别是同一个思路。
 */

/** 太常见的词，字面匹配它们只会把无关段落全捞进来 */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "what", "how", "why", "who",
  "is", "are", "was", "were", "does", "did", "can", "should", "would",
  "里", "的", "了", "是", "在", "有", "和", "与", "或", "什么", "怎么", "如何",
  "为什么", "哪些", "哪个", "介绍", "讲了", "说了", "提到", "关于", "一下",
]);

/**
 * 抽取关键词。只要「字面匹配才找得到」的那类词：
 *
 *  · 全大写缩写      SFT / RL / QAT 这类
 *  · 带数字或连字符  型号名、版本号、代号
 *  · 驼峰            LatentMoE / KimiDelta
 *  · 引号里的内容    "永恒回归"
 *  · 普通英文单词    人名、机构名等专有名词
 *
 * 刻意不抽中文词——浏览器里没有好用的中文分词，而中文语义检索本来就准；
 * 真正的盲区是模型没见过的 ASCII 专有名词。
 */
export function keyTerms(question: string): string[] {
  const out = new Set<string>();

  // 引号里的整体优先，可能含空格
  for (const m of question.matchAll(/[「『"'“”]([^」』"'“”]{2,40})[」』"'“”]/g)) {
    out.add(m[1].trim());
  }

  for (const m of question.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g)) {
    const w = m[0];
    if (w.length < 2 || STOP.has(w.toLowerCase())) continue;
    // 全小写且没有数字连字符的普通词，只有够长才留——短词噪音太大
    const distinctive = /[A-Z0-9]/.test(w) || /[-_.]/.test(w);
    if (!distinctive && w.length < 5) continue;
    out.add(w);
  }

  return [...out].slice(0, 8);
}

/**
 * 这句追问需不需要先改写成独立查询。
 *
 * 改写是为「那第二点展开说说」准备的——那种句子不含任何可检索的实词。
 * 但多数追问其实是完整的新问题，改写只会丢字：实测一句带引号的完整问题
 * 被改写后，原本 0.63 / 0.56 的两篇正确文章一篇都没进来，反而召回了
 * 一篇 0.53 的无关文章。所以宁可少改写。
 *
 * 判据只看句子开头和长度，不看句中有没有「这/那」——
 * 「这两个主张同时成立」里的「这」指的是同一句里刚说过的内容，
 * 不需要向历史求解。
 */
const LEADING_ANAPHORA =
  /^[\s"'「『“”（(]*(那|这|它|他|她|其中|前者|后者|接着|然后|继续|再|还有|另外|为什么|怎么|如何|展开|详细|具体|举例|第[一二三四五六七八九十百\d]+[点条个部分节]|上面|前面|刚才|之前|你说的|你提到)/;

export function needsRewrite(followUp: string): boolean {
  const s = followUp.trim();
  // 太短的一定要改写：「继续」「为什么呢」本身没有可检索的实词
  if (s.length < 15) return true;
  return LEADING_ANAPHORA.test(s);
}

export interface TimeRange {
  /** 只要这个时间点之后修改过的文件 */
  since: number;
  /** 展示用的名字，比如「最近 7 天」 */
  label: string;
  labelEn: string;
}

const DAY = 86400_000;

/** 中文数字。「最近两周」里的「两」不是 \d，不处理就会掉进「最近」的兜底分支。 */
const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 半: 0,
};

function num(raw: string | undefined): number {
  if (!raw) return NaN;
  const t = raw.trim();
  if (/^\d+$/.test(t)) return Number(t);
  return CN_NUM[t] ?? NaN;
}

/**
 * 识别「上周记了什么」这类时间限定。
 *
 * 语义检索对时间完全无能——「最近」在向量空间里没有任何意义，
 * 而文件的 mtime 明明就在索引里躺着。
 */
export function timeRange(question: string, now = Date.now()): TimeRange | null {
  const q = question.toLowerCase();

  const CN = "一两二三四五六七八九十";
  const nDay = new RegExp(`(?:最近|过去|近)\\s*(\\d+|[${CN}]{1,2})\\s*(?:天|日)|last\\s+(\\d+)\\s+days?`).exec(q);
  if (nDay) {
    const n = num(nDay[1] ?? nDay[2]);
    if (n > 0 && n <= 3650) {
      return { since: now - n * DAY, label: `最近 ${n} 天`, labelEn: `last ${n} days` };
    }
  }

  const nWeek = new RegExp(`(?:最近|过去|近)\\s*(\\d+|[${CN}]{1,2})\\s*(?:周|个?星期)|last\\s+(\\d+)\\s+weeks?`).exec(q);
  if (nWeek) {
    const n = num(nWeek[1] ?? nWeek[2]);
    if (n > 0 && n <= 520) {
      return { since: now - n * 7 * DAY, label: `最近 ${n} 周`, labelEn: `last ${n} weeks` };
    }
  }

  const nMonth = new RegExp(`(?:最近|过去|近)\\s*(\\d+|[${CN}]{1,2})\\s*个?月|last\\s+(\\d+)\\s+months?`).exec(q);
  if (nMonth) {
    const n = num(nMonth[1] ?? nMonth[2]);
    if (n > 0 && n <= 120) {
      return { since: now - n * 30 * DAY, label: `最近 ${n} 个月`, labelEn: `last ${n} months` };
    }
  }

  // 固定说法。「最近」不带数字时按 30 天——比一周宽松，
  // 因为多数人说「最近在看什么」指的是这一阵子，不是这七天。
  const fixed: Array<[RegExp, number, string, string]> = [
    [/今天|today/, 1, "今天", "today"],
    [/昨天|yesterday/, 2, "最近两天", "last 2 days"],
    [/这周|本周|这个星期|this week/, 7, "本周", "this week"],
    [/上周|上个星期|last week/, 14, "最近两周", "last 2 weeks"],
    [/这个月|本月|this month/, 30, "本月", "this month"],
    [/最近|近期|这阵子|recently|lately/, 30, "最近一个月", "the last month"],
  ];
  for (const [re, days, label, labelEn] of fixed) {
    if (re.test(q)) return { since: now - days * DAY, label, labelEn };
  }
  return null;
}
