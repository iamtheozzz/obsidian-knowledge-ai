import { Embedder } from "../embedder";
import { resolveAnswerLang, type Locale } from "../i18n";
import type { IndexStore, Hit } from "../index/store";
import { embedBase } from "../models";
import { aboutUserPrompt, bareQuestion, rewritePrompt, speaker, systemPrompt, userPrompt } from "../prompts";
import type { KnowledgeAiSettings } from "../settings";
import { StreamCleaner } from "../clean";
import { keyTerms, timeRange } from "../query";
import { ctxFromError, streamChat } from "../stream";
import type { AiBackend, AskEvent, AskOptions, Source, Turn } from "./types";

/** 限定文件后的召回段数。范围已经窄了，多给几段只是把同一篇读得更全。 */
const SCOPED_TOPK = 32;

/** 限定文件时显式申请的上下文窗口。 */
const SCOPED_CTX = 32768;   // 实测再往上到 65536 要 134 秒，且只剩 0.6GB 内存

/**
 * 平时申请的上下文窗口。
 *
 * 必须显式传：Ollama 默认只给 4096，撞墙后 ctxCache 会把 4096 记下来，
 * 之后整个会话的材料预算被锁死在 2992 字符——只够两段，召回的 8 段有 6 段
 * 被静默丢弃。而模型本身支持 256K。
 */
const DEFAULT_CTX = 32768;

/** 限定文件时的相似度下限。比全库的 0.5 低得多，理由见调用处。 */
const SCOPED_THRESHOLD = 0.3;

/**
 * Design 2：插件总是先检索，再把材料塞进 prompt 让模型作答。
 * 不依赖模型支持工具调用，一次模型调用出结果，比 agent 循环快得多。
 */
export class LocalBackend implements AiBackend {
  constructor(
    private settings: KnowledgeAiSettings,
    private store: IndexStore
  ) {}

  async ask(opts: AskOptions, emit: (e: AskEvent) => void): Promise<void> {
    const { question, history, scope, signal, images, pinned } = opts;
    const lang = resolveAnswerLang(this.settings.answerLang, question);

    try {
      emit({ type: "searching" });

      // 指定了材料就直接用，不检索。「这页讲了什么」走这条路：整页原样送进去。
      // 放在最前面——这条路既不需要追问改写，也不需要算向量，两次调用都省了。
      if (pinned?.length) {
        emit({ type: "found", hits: pinned });
        await this.generate(lang, pinned, question, history, images, signal, emit, false, true);
        return;
      }

      // 带图片时不检索。问「这张图里有什么」时笔记内容是纯噪音，
      // 既污染答案又白白吃掉上下文——而视觉模型的窗口往往还特别小。
      if (images?.length) {
        emit({ type: "found", hits: [] });
        await this.generate(lang, [], question, history, images, signal, emit);
        return;
      }

      // 追问不能直接拿去检索：「那第二点展开说说」没有可检索的实词
      const query = history.length
        ? await this.rewrite(question, history, lang, signal)
        : question;

      const emb = new Embedder(
        embedBase(this.settings),
        this.settings.embedModel,
        this.settings.apiKey
      );
      const [qv] = await emb.embed([query]);
      if (signal.aborted) return;


      // 多取一些再去重：切块有重叠，同一页往往连命中好几块
      // 限定文件后召回预算可以放开：范围已经窄到一两个文档，
      // 多给几段只是把同一篇读得更全，不会引进无关内容。
      // 47 页的论文有 183 段，topK=8 只覆盖 4.4%——问「后训练怎么做的」
      // 这种要翻正文的问题根本不够。
      const k = scope?.length ? Math.max(this.settings.topK, SCOPED_TOPK) : this.settings.topK;
      // 限定文件后阈值要放低。0.5 是为全库检索定的——那里必须挡住无关文档。
      // 范围已经收窄到指定文件时，相关性由 scope 保证，阈值反而成了瓶颈：
      // 实测 47 页的论文里只有 5 段过得了 0.5，把 topK 从 8 加到 24 完全没用，
      // 拿到的是同样 4 页材料。放到 0.3 之后覆盖 23 个页面，答案细得多。
      const th = scope?.length
        ? Math.min(this.settings.threshold, SCOPED_THRESHOLD)
        : this.settings.threshold;

      const range = timeRange(question);
      const since = range?.since;
      const dense = this.store.search(qv, k * 6, th, scope, since);

      // 混合检索：语义那一路对罕见专有名词是盲区。实测问一个四字母缩写时
      // 最高分只有 0.439、过不了阈值，插件会回答「库里没有」——而库里有 3 段；
      // 一个不常见的机构名更是前 8 名一条都不命中。字面那一路专治这个。
      // 关键词命中不受相似度阈值约束，那正是它存在的意义。
      const terms = keyTerms(question);
      const lexical = terms.length ? this.store.keyword(terms, k * 3, scope, since) : [];

      let hits = twoTier(dedupe(fuse(dense, lexical)), k);      // 限定文件时，无条件把每个文件开头带上——标题和摘要在那里，
      // 而「这篇讲了什么」的语义最接近的其实是结论页和参考文献页。
      if (scope?.length) {
        const per = scope.length === 1 ? 2 : 1;
        const head = scope.flatMap((p) => this.store.headOf(p, per));
        const seen = new Set(hits.map((h) => `${h.path}#${h.page}#${h.line}`));
        const extra = head.filter((h) => !seen.has(`${h.path}#${h.page}#${h.line}`));
        hits = [...extra, ...hits].slice(0, k);
      }
      emit({
        type: "found",
        hits,
        since: range ? (lang === "zh" ? range.label : range.labelEn) : undefined,
      });

      // 只有召回里确实混了收藏的书时，才值得多花一次分类调用
      const aboutUser = hits.some((h) => isCollected(h.path))
        ? await this.aboutUser(question, lang, signal)
        : false;
      if (signal.aborted) return;

      await this.generate(
        lang, hits, question, history, images, signal, emit, aboutUser,
        Boolean(scope?.length)
      );
    } catch (e) {
      if (signal.aborted) return;
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 拼消息 → 流式生成 → 收尾。带图和不带图共用这一段。 */
  private async generate(
    lang: Locale,
    hits: Hit[],
    question: string,
    history: Turn[],
    images: string[] | undefined,
    signal: AbortSignal,
    emit: (e: AskEvent) => void,
    aboutUser = false,
    scoped = false
  ): Promise<void> {
    const hasImages = Boolean(images?.length);
    const model = this.modelFor(hasImages);

    // 实际窗口由后端决定，从元数据预测不出来（同样没设 num_ctx，
    // MLX 后端能吃 5500 token，GGUF 卡在 4096）。所以先按乐观值发，
    // 撞墙时从报错里读出真实的 n_ctx 记下来，自动重试一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      const used = trimToBudget(hits, this.budgetFor(model, scoped));
      const messages = this.buildMessages(lang, used, question, history, images, aboutUser);
      const cleaner = new StreamCleaner();
      let answer = "";
      try {
        await streamChat(
          this.settings,
          messages,
          signal,
          (chunk) => {
            const visible = cleaner.push(chunk);
            if (visible) {
              answer += visible;
              emit({ type: "token", text: visible });
            }
          },
          {
            model,
            // 限定文件时材料多，显式要一个大窗口。Ollama 默认只给 4096，
            // 不说的话再多的材料也塞不进去。撞墙了会走自愈重试。
            numCtx: LocalBackend.ctxCache.get(model) ?? (scoped ? SCOPED_CTX : DEFAULT_CTX),
          }
        );
      } catch (e) {
        const limit = ctxFromError(e);
        if (limit && attempt === 0) {
          LocalBackend.ctxCache.set(model, limit);
          continue;                       // 用学到的真实窗口重来
        }
        throw e;
      }
      const tail = cleaner.flush();
      if (tail) {
        answer += tail;
        emit({ type: "token", text: tail });
      }
      emit({
        type: "done",
        answer: answer.trim(),
        sources: toSources(used),
        usedChunks: used.length,
      });
      return;
    }
  }

  private modelFor(hasImages: boolean): string {
    return hasImages && this.settings.visionModel
      ? this.settings.visionModel
      : this.settings.chatModel;
  }

  /** 会话内学到的真实上下文窗口，键是模型名 */
  private static ctxCache = new Map<string, number>();

  /** 材料的字符预算。没撞过墙就按 16K 乐观值来，撞过就用学到的真值。
   *  中文约 2 字符/token，留 2600 token 给回答、系统提示和历史。 */
  /**
   * 材料的字符预算。按 2 字符/token 保守折算（中文最密的情况）。
   *
   * 上限不是被上下文卡住的，是被时间卡住的：实测一个 9B 的 8bit 量化模型
   * 38K 字符要 56 秒、76K 字符要 134 秒，而且内存只剩 0.6GB。所以封顶值
   * 按「还能忍的等待时间」定，不是按窗口能装多少定。
   */
  private budgetFor(model: string, scoped = false): number {
    const ctx = LocalBackend.ctxCache.get(model) ?? (scoped ? SCOPED_CTX : DEFAULT_CTX);
    return Math.min(Math.max(500, ctx - 2600) * 2, scoped ? 55000 : 40000);
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 极短的一次分类调用。
   *
   *  temperature 必须是 0：默认的 0.3 会让同一个问题两次跑出不同答案，
   *  表现是「有时走收藏清单、有时把书的正文全发进去」，行为看着像随机的。
   *
   *  失败就当「否」——宁可多给材料，不要因为分类挂了把正常提问降级成只有标题。 */
  private async aboutUser(question: string, lang: Locale, signal: AbortSignal): Promise<boolean> {
    try {
      let out = "";
      await streamChat(this.settings,
        [{ role: "user", content: aboutUserPrompt(lang, question) }],
        signal, (c) => (out += c), { maxTokens: 4, temperature: 0 });
      return /^\s*(是|yes)/i.test(out.replace(/<think>[\s\S]*?<\/think>/g, "").trim());
    } catch {
      return false;
    }
  }

  private buildMessages(
    lang: Locale, hits: Hit[], question: string, history: Turn[],
    images?: string[], aboutUser = false
  ) {
    const grounded = this.settings.vaultRetrieval;
    const msgs: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt(lang, grounded, aboutUser) },
    ];
    // 历史只带文字，不重复塞材料——每轮都塞会迅速撑爆上下文
    for (const h of history) msgs.push({ role: h.role, content: h.content });

    if (hits.length === 0) {
      // 没有够格的材料就干净地问，不解释、不铺垫
      msgs.push({ role: "user", content: bareQuestion(question) });
    } else {
      // 问用户本人时，收藏的书不进材料区，只在末尾列一行标题清单。
      // 不能给空的 <材料 标题="X"></材料>：实测模型会拿旁边那段的内容
      // 把空壳填上，把另一篇文章里的话说成是这本书里的。
      // 也不能给正文——只要看得到书里的情节，4B 就一定会写出
      // 「《某某书》里提到你曾经如何如何」（那其实是书作者的经历）。
      const shown = aboutUser ? hits.filter((h) => !isCollected(h.path)) : hits;
      const listed = aboutUser ? hits.filter((h) => isCollected(h.path)) : [];
      const blocks = shown.map((h, i) =>
        `<材料 序号="${i + 1}" 类型="${sourceKind(lang, h.path)}" 标题="${baseName(h.path)}">\n${h.text}\n</材料>`
      );
      if (listed.length) {
        const titles = [...new Set(listed.map((h) => baseName(h.path)))].join("、");
        blocks.push(`<收藏清单>${titles}</收藏清单>`);
      }
      const material = blocks.join("\n\n");

      const allCollected = hits.every((h) => isCollected(h.path));
      msgs.push({ role: "user", content: userPrompt(lang, material, question, allCollected) });
    }
    // 有图片时把最后一条 user 消息改成多模态格式
    if (images?.length) {
      const last = msgs[msgs.length - 1];
      last.content = [
        { type: "text", text: String(last.content) },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ] as unknown as string;
    }
    return msgs;
  }

  /** 用一次极短的非流式调用把追问改写成独立查询 */
  private async rewrite(
    followUp: string,
    history: Turn[],
    lang: Locale,
    signal: AbortSignal
  ): Promise<string> {
    const ctx = history
      .slice(-4)
      .map((h) => `${speaker(lang, h.role)}${h.content.slice(0, 300)}`)
      .join("\n");
    try {
      let out = "";
      await streamChat(
        this.settings,
        [{ role: "user", content: rewritePrompt(lang, ctx, followUp) }],
        signal,
        (c) => (out += c),
        { maxTokens: 200 }
      );
      const clean = out.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
      // 改写失败就退回原句，总比拿一句空话去检索强
      return clean.length >= 2 ? clean.split("\n")[0].slice(0, 200) : followUp;
    } catch {
      return followUp;
    }
  }

}

/**
 * 同一处内容只留一条。PDF 按页去重，md 按 40 行一段去重——
 * 相邻 chunk 有 150 字符重叠，不去重的话检索结果里会出现几乎一样的两段，
 * 既浪费预算又让模型觉得「这点被反复强调」。
 */
function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits) {
    const key = h.page
      ? `${h.path}#p${h.page}`
      : `${h.path}#l${Math.floor(h.line / 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * 按字符预算从高分往低分收，装不下就停。
 * 兜底：如果第一段就超预算，截断它也要塞进去——
 * 宁可给半段材料，也不要让模型在完全没有依据的情况下作答。
 */
function trimToBudget(hits: Hit[], budget: number): Hit[] {
  const out: Hit[] = [];
  let used = 0;
  for (const h of hits) {
    if (used + h.text.length > budget) break;
    out.push(h);
    used += h.text.length;
  }
  if (out.length === 0 && hits.length) {
    out.push({ ...hits[0], text: hits[0].text.slice(0, Math.max(200, budget)) });
  }
  return out;
}

/**
 * 生成参考资料。按「文件 + 页」去重，不是只按文件。
 *
 * 早先只按文件去重、留分数最高那一段，结果一本 400 页的书无论命中几页
 * 都只给一个链接。答案里明明引了第 213、220、331 页的内容，用户却只能
 * 跳到其中一页——渲染时会把同一文件的多页收成一行，所以这里不必怕啰嗦。
 */
function toSources(hits: Hit[]): Source[] {
  const seen = new Map<string, Source>();
  for (const h of hits) {
    const key = `${h.path}#${h.page || 0}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      path: h.path,
      line: h.line,
      page: h.page,
      title: baseName(h.path),
    });
  }
  return [...seen.values()];
}

/**
 * 倒数排名融合（RRF）。两路检索的分数量纲完全不同——余弦相似度在 0–1，
 * IDF 打分没有上界——直接相加或加权平均都要先归一化，而归一化本身
 * 就要猜参数。RRF 只看名次不看分数，没有可调参数，正是为这种场合设计的。
 *
 * 只出现在一路里的结果不会被埋没：k=60 时第 1 名得 1/61，第 20 名得 1/80，
 * 差距是温和的，所以字面检索独有的命中仍然排得进前列。
 */
function fuse(dense: Hit[], lexical: Hit[]): Hit[] {
  const K = 60;
  const rank = new Map<string, { hit: Hit; score: number }>();
  const key = (h: Hit) => `${h.path}#${h.page}#${h.line}`;
  for (const list of [dense, lexical]) {
    list.forEach((h, i) => {
      const id = key(h);
      const prev = rank.get(id);
      const add = 1 / (K + i + 1);
      if (prev) prev.score += add;
      else rank.set(id, { hit: h, score: add });
    });
  }
  // 排序用 RRF，但 score 字段留原始相似度——界面上要显示的是
  // 「0.66」这种看得懂的数，不是 0.016 的融合分。
  return [...rank.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ hit }) => hit);
}

/**
 * 两级检索：先保证用户自己库里的笔记进来，剩下的名额再给收藏的 PDF。
 *
 * 起因是索引构成极度倾斜——实测一个库里 96% 的段落来自 Books/ 下的 PDF，
 * 用户自己的笔记只占 4%。纯按相似度排序时，书几乎必然把笔记挤掉：
 * 问「我最近在研究什么」，前十名全是书，一条自己的笔记都没有。
 *
 * 做法是给笔记留出至少一半名额（有多少给多少），不够的部分才由 PDF 补足。
 * 两边内部仍按分数排序，所以问书里的内容时行为不变——那种问题本来
 * 就召不到几条笔记，名额自然全给 PDF。
 */
function twoTier(hits: Hit[], topK: number): Hit[] {
  const own = hits.filter((h) => !isCollected(h.path));
  const rest = hits.filter((h) => isCollected(h.path));
  const quota = Math.ceil(topK / 2);
  const picked = new Set([
    ...own.slice(0, quota),
    ...rest.slice(0, topK - Math.min(own.length, quota)),
  ]);
  // 保持传入顺序（已经是 RRF 融合过的名次），不要按 score 重排——
  // score 现在是原始相似度，用它排会把字面检索独有的命中挤到后面，
  // 而那些恰恰是语义检索找不到的东西。
  return hits.filter((h) => picked.has(h)).slice(0, topK);
}

function isCollected(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/**
 * 粗判材料是谁写的。只按扩展名分：PDF 一律算收藏的他人著作，
 * md 算库内笔记。不准——库里的剪藏文章也是 md——但方向是对的：
 * 至少让模型知道 PDF 里的内容不是用户自己写的。
 */
function sourceKind(lang: Locale, path: string): string {
  const own = !isCollected(path);
  if (lang === "zh") return own ? "库内笔记" : "收藏的文档（他人著作）";
  return own ? "note in vault" : "collected document (someone else's work)";
}

function baseName(p: string): string {
  return (p.split("/").pop() ?? p).replace(/\.(md|pdf|qmd)$/i, "");
}
