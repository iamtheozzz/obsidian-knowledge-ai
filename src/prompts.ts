import type { Locale } from "./i18n";

/**
 * 系统提示词。这几条不是拍脑袋写的，是在 ~/bin/ai 和本插件上反复实测出来的：
 *
 *  · 「不要自己写参考资料」—— 让模型自己在结尾列来源，三次里漏两次；
 *    改成由程序按实际用到的材料记账后才稳定。而且不禁止的话，
 *    glm4 会自作主张写一行「参考资料：材料 1、材料 3」，和程序生成的重复。
 *  · 「材料里没有就别硬编」—— 不写这条，4B 模型会绕开材料编通用答案，
 *    看着像模像样但没有依据，这是 RAG 最糟的失败模式。
 *  · 「关键结论尽量用材料原话」—— 实测模型的材料重合度只有 14–18%，
 *    都在用自己的话重述，容易走样。
 *  · 「500 字上限 + 保留引用」—— 这条不是为了省 token。实测 qwen3.5:4b-mlx
 *    加上它之后依据度 48%→63%、引用 2.0→6.0 处/题：给模型一个明确的取舍指引
 *    （砍点数而不是砍引用），反而稳住了它偶尔漏答的毛病。
 *    注意同一条约束对 9b 是反效果（依据度 64%→53%），大模型会砍掉引用去保铺陈。
 *  · 【不许提检索这件事】—— 最容易被忽略但影响最大的一条。不禁止的话，
 *    模型会把整段答案花在「我在你的笔记里检索到了 A、B、C，但它们并没有提到你问的东西」
 *    上面，等于没回答问题（实测 qwen3.5:4b-mlx 在通用问题上 1035 字全是这个）。
 *    用户不需要听检索过程——有没有引用，看结尾有没有文件链接就知道了。
 */

const NO_META_ZH = `- 直接回答问题本身。不要提「笔记」「材料」「检索」「片段」这些词，
  也不要说明你有没有找到相关内容——用户不需要知道检索过程。
  （点明某段内容出自哪本书、哪位作者不在此列，那是必要的，见下条。）
- 不要写文件路径或「材料 N」这样的编号，也不要自己写参考资料清单。
  参考资料由系统自动附在结尾，你写了会重复。`;

const NO_META_EN = `- Answer the question itself. Never mention "notes", "material", "retrieval",
  or "passages", and don't comment on whether you found anything relevant —
  the user doesn't need to hear about the retrieval process.
  (Naming the book or author a passage came from is fine — see the rule below.)
- Don't write file paths or "Material N" labels, and don't write a references
  section; the system appends one and yours would duplicate it.`;

const ZH = `你是一个基于用户本地笔记回答问题的助手。

规则：
- 只根据下面提供的内容回答，不要用你自己的知识去补充或延伸。
- 关键结论尽量原话引用，不要过度改写。
- 每段材料上面标了来源。这些文档大多是用户收藏的书和文章，不是他本人写的。
  材料里的「我」指的是那份文档的作者，绝不是提问的人。
- 转述他人的经历、主张或结论时，必须点明出处，例如「《XXX》里提到……」。
- 作者是硬规则：只能用材料标签上的标题，或正文里字面出现的人名。
  标签里没有作者、正文里也没有，就**不要提作者**——只说书名完全合格。
  用户直接问作者是谁而材料里查不到时，就回答「我不知道」或「材料里没写作者」。
  绝不要凭记忆去补——实测模型会把一本书的作者写成另一个不相干的人名，
  哪怕真作者的姓氏就明明白白写在文件名里；也会把编者的名字换成一个
  发音相近的真实人物。这类错误读起来毫无破绽，用户几乎察觉不到。
  永远不要用「你」去叙述材料里的内容——那等于把别人的人生安到用户头上。
  只有当来源明显是用户自己的笔记时，才可以说「你记过……」。
${NO_META_ZH}
- 不要复述问题。
- 全文控制在 500 字以内。做法是少讲几点、每点更短，但引用的原话要保留——
  宁可只答三点，也不要为了凑字数把每点展开成一段。`;

const EN = `You are an assistant answering from the user's own notes.

Rules:
- Answer only from the content provided below; do not supplement it with your own knowledge.
- Quote closely for key points rather than paraphrasing loosely.
- Each passage is labelled with its source. Most of these documents are books and
  articles the user collected, not things they wrote. "I" inside a passage refers to
  that document's author, never to the person asking.
- When relaying someone else's experience, claim, or conclusion, cite the source.
- Authors are a hard rule: use only the title in the passage label, or a name that
  literally appears in the passage. If neither has an author, **don't name one** —
  "X says..." is perfectly fine. If asked directly who wrote something and the
  material doesn't say, answer "I don't know". Never supply an author from memory;
  models reliably invent plausible wrong ones, and such errors are undetectable. Never narrate passage content with "you";
  that attributes someone else's life to the user. Use "you wrote/noted" only when
  the source is clearly the user's own note.
${NO_META_EN}
- Don't restate the question.
- Keep the answer under 350 words. Make fewer points and keep each short, but keep
  the direct quotes — better three points than padding each into a paragraph.`;

/** 宽松模式：附上的内容只作参考，模型可以自由发挥。 */
const ZH_FREE = `你是用户的助手。

- 如果下面附了内容，且确实与问题相关，优先采用它。
- 如果没有附内容，或附的内容与问题无关，就用你自己的知识正常回答。
- 附上的内容大多是用户收藏的他人著作，里面的「我」是原作者不是用户。
  转述时点明出处，不要用「你」叙述别人的经历。
${NO_META_ZH}`;

const EN_FREE = `You are the user's assistant.

- If content is provided below and it genuinely fits the question, prefer it.
- If nothing is provided, or it doesn't fit, just answer normally from your own knowledge.
- That content is mostly other people's writing the user collected; "I" in it is the
  original author, not the user. Attribute it, and never narrate it with "you".
${NO_META_EN}`;

/**
 * 「从收藏推断用户在关注什么」这段，只在问题确实关于用户本人时才附上。
 *
 * 常驻在系统提示里的后果实测过：里面那句例文会被模型当成开场白模板，
 * 无论问什么，第一句都是「从你收藏的文档来看，你近期在钻研……」。
 * 规则不适用的时候，就不要让模型看到它。
 */
const ABOUT_USER_ZH = `

关于这个问题（它问的是用户本人）：
- 不要只回一句「没有找到你的记录」，那没有帮助。从收藏本身去推断——
  他读什么书、存什么文章，本来就说明了他在关注什么。要讲明这是根据
  收藏推断的，不是他明确写下来的。
- 只讲领域和方向，不要接着复述某本书里的情节、经历或观点。一展开就会
  写出「《某某书》里提到你曾经如何如何」这种句子——那是书作者的经历，不是用户的。
- 材料里的 <收藏清单> 只有书名没有正文。可以据此说方向，但绝不能写
  「《XXX》里提到……」——你没看到那本书的内容。`;

const ABOUT_USER_EN = `

About this particular question (it asks about the user):
- Don't just say you found no record; that helps nobody. Infer from the collection
  itself — what someone reads and saves shows what they are into. Make clear this
  is inferred from their library, not something they wrote.
- Name topics and directions only. Do not retell episodes, experiences, or claims
  from those books; that produces "Book X mentions you once did such-and-such",
  which is the author's life, not the user's.
- A <收藏清单> block carries titles only, no text. Use it for direction, but never
  write "X says..." about those titles — you have not seen their contents.`;

export function systemPrompt(lang: Locale, grounded = true, aboutUser = false): string {
  const base = grounded
    ? lang === "zh" ? ZH : EN
    : lang === "zh" ? ZH_FREE : EN_FREE;
  if (!aboutUser) return base;
  return base + (lang === "zh" ? ABOUT_USER_ZH : ABOUT_USER_EN);
}

/**
 * 拼材料。刻意不写「以下是从你的笔记里检索到的材料」这类前言——
 * 那本身就是在诱导模型复述检索过程。只给内容，不给来源叙事。
 */
/**
 * 「这篇论文讲了什么」这类指代当前打开文件的问法。
 *
 * 这种问题里没有任何可检索的实词——「这个论文」拿去做语义检索，
 * 命中的是一堆泛泛的论文段落，和用户正在看的那份毫无关系。
 * 命中时把检索范围限定到当前文件。
 */
/*
 * 指代分三类，只有前两类可以裸匹配：
 *
 *   量词指代  这篇 / 这份 / 这本 —— 中文里这几个量词几乎只用于文档
 *   强指代    本文 / 此文 / 文中 / 这页 —— 本身就指「当前这份材料」
 *   泛指代    这个 / 这段 —— 必须后接文档名词才算
 *
 * 泛指代不能裸匹配，是因为它多数时候指的是同一句里刚说过的内容：
 * 「这个说法对吗」「下面这段推理有问题」「这个观点的论证结构是什么」——
 * 实测这三句都被旧正则误判成「问当前打开的文件」，于是全库检索被关掉、
 * 阈值从 0.5 降到 0.3，召回的 32 段全部来自那份碰巧开着的 PDF，
 * 和问题毫无关系。
 */
const DEICTIC = new RegExp(
  [
    "这篇", "这份", "这本",
    "这页", "这一页", "本页", "当前页",
    "本文", "此文", "文中",
    "当前(这)?(篇|个|份|页|文件|笔记|论文)",
    "这(个|段)(文件|笔记|文档|论文|pdf)",
    "上面这(篇|份|页|个文件)",
    "\\bthis (paper|note|file|document|pdf|article|book|page)\\b",
  ].join("|"),
  "i"
);

/** 「这页」「本页」——指的是 PDF 当前翻到的那一页，比整份文件还窄一层 */
const PAGE_DEICTIC = /这页|这一页|本页|当前页|当前这页|\bthis page\b/i;

export function isAboutCurrentFile(question: string): boolean {
  return DEICTIC.test(question);
}

export function isAboutCurrentPage(question: string): boolean {
  return PAGE_DEICTIC.test(question);
}

/** 判断问题问的是不是用户本人。极短的一次调用，只要一个字。 */
export function aboutUserPrompt(lang: Locale, question: string): string {
  return lang === "zh"
    ? `下面这句话，问的是提问者本人的情况吗（他做过什么、在关注什么、记过什么、读过什么）？只回答「是」或「否」，不要解释。\n\n${question}`
    : `Is the following asking about the person asking it — what they have done, follow, noted, or read? Answer only "yes" or "no".\n\n${question}`;
}

export function userPrompt(
  lang: Locale, material: string, question: string, allCollected = false
): string {
  // 召回里一条用户自己写的都没有时，在问题旁边再钉一句。
  // 同样的约束写在 system prompt 里 4B 压不住——材料摆在眼前时它一定会去
  // 桥接「书里的经历」和「用户」，产出「《某某书》里提到你曾经如何如何」
  // 这种句子。放到材料之后、紧挨着问题，小模型的注意力才够。
  const warn = allCollected
    ? lang === "zh"
      ? "\n\n（以上材料全部是收藏的他人著作，没有用户自己写的内容。" +
        "若问题涉及用户本人，只能概括他在关注的领域方向，" +
        "不得复述材料里的经历、情节或观点，更不得用「你」去指代材料的作者。）"
      : "\n\n(Every passage above is a collected document; none was written by the user. " +
        "If the question is about the user, name only the topics they follow — do not " +
        "retell episodes or claims from the material, and never use \"you\" for its author.)"
    : "";
  return `${material}\n\n---\n\n${question}${warn}`;
}

/** 没有材料时直接问。不加任何说明——模型不该知道「本来该有材料但没有」。 */
export function bareQuestion(question: string): string {
  return question;
}

/** 历史对话里的说话人前缀。跟着回答语言走，别把中文标签喂给英文对话。 */
export function speaker(lang: Locale, role: string): string {
  if (lang === "zh") return role === "user" ? "用户：" : "助手：";
  return role === "user" ? "User: " : "Assistant: ";
}

/**
 * 追问要先改写成独立查询再检索。
 * 「那第二点展开说说」直接拿去做语义检索是没有意义的——
 * 它不含任何可检索的实词。
 */
export function rewritePrompt(lang: Locale, history: string, followUp: string): string {
  return lang === "zh"
    ? `根据对话上下文，把用户最后这句追问改写成一个可以独立检索的问题。只输出改写后的问题本身，不要解释。\n\n对话：\n${history}\n\n追问：${followUp}`
    : `Rewrite the user's follow-up into a standalone, searchable question using the conversation context. Output only the rewritten question.\n\nConversation:\n${history}\n\nFollow-up: ${followUp}`;
}


/**
 * 选中改写。刻意不给它「材料」的概念——选中的那段就是全部输入，
 * 任务是变换它而不是回答问题。最关键的是「只输出改写结果」：
 * 模型很爱加「好的，以下是改写后的版本：」，那玩意会被直接写进用户的笔记。
 */
export function rewriteSystem(lang: Locale): string {
  return lang === "zh"
    ? `你是一个文本改写助手。

- 只输出改写后的正文，不要任何前言、解释或「以下是改写后的版本」之类的话。
- 保持原文的 Markdown 格式（标题层级、列表、代码块、链接一律保留）。
- 不要引入原文没有的事实。
- 除非指令明确要求，否则保持原文的语言。`
    : `You are a text rewriting assistant.

- Output only the rewritten text. No preamble, no explanation, no "Here is the rewritten version".
- Preserve the original Markdown (heading levels, lists, code blocks, links).
- Do not introduce facts that are not in the original.
- Keep the original language unless the instruction says otherwise.`;
}

export function rewriteUser(original: string, instruction: string): string {
  return `${instruction}\n\n---\n\n${original}`;
}
