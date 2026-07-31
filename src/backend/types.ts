import type { Hit } from "../index/store";

/** 一次提问过程中推出来的事件。UI 只认这些，不关心后端怎么实现。 */
export type AskEvent =
  | { type: "searching" }
  | { type: "found"; hits: Hit[]; since?: string }
  | { type: "token"; text: string }
  // usedChunks 是真正塞进 prompt 的段数，可能少于召回数——
  // 字符预算会把塞不下的砍掉。两个数不一样时必须让用户看见。
  | { type: "done"; answer: string; sources: Source[]; usedChunks: number }
  | { type: "error"; message: string };

/** 参考资料一条。由程序按实际用到的材料生成——
 *  让模型自己在结尾写参考资料实测不可靠，三次里漏两次。 */
export interface Source {
  path: string;
  line: number;
  page: number;
  title: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface AskOptions {
  question: string;
  history: Turn[];
  /** 限定检索范围的库内路径，空表示全库。指代当前文件或用户手选的文件。 */
  scope?: string[];
  /** scope 是从「这篇/本文」这类指代猜出来的，不是用户手选的。
   *  猜错的代价很大（全库检索被关掉），所以后端会在召回质量太差时退回全库。
   *  手选的范围必须无条件尊重，不走这条退路。 */
  scopeInferred?: boolean;
  /** 直接指定要用的材料，跳过检索。「这页讲了什么」用它送整页。 */
  pinned?: Hit[];
  /** 本轮附带的图片（data URL）。非空时改用视觉模型。 */
  images?: string[];
  signal: AbortSignal;
}

export interface AiBackend {
  ask(opts: AskOptions, emit: (e: AskEvent) => void): Promise<void>;
}
