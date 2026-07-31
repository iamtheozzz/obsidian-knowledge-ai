import type { AnswerLangSetting, UiLangSetting } from "./i18n";

export interface KnowledgeAiSettings {
  // 模型
  endpoint: string;
  chatModel: string;
  apiKey: string;
  /** 提问带图片时改用这个模型。留空则沿用对话模型。
   *  分开是因为二者常常不能兼得：Ollama 的 MLX 后端文字质量更好，
   *  但目前收不到图片（会退化成 [img-0] 占位符）；GGUF 能看图但文字略逊。 */
  visionModel: string;

  /** 嵌入用的端点。留空则跟随上面的 endpoint。
   *  分开是因为两者常常不在一处：对话用云端或 mlx_lm.server，
   *  嵌入用本地 Ollama——共用一个地址时索引会打到不提供嵌入的服务上。 */
  embedEndpoint: string;

  // 语言
  uiLang: UiLangSetting;
  answerLang: AnswerLangSetting;

  // 索引
  scopeFolders: string[];     // 空数组 = 全库

  /** 不进索引的文件夹（也可以填单个文件的完整路径）。
   *  优先级高于 scopeFolders：同时命中时以忽略为准。
   *  典型用途是把测试题库、草稿、私人日记挡在检索之外——
   *  这类文件留在库里有用，但被召回时会盖住真正该答的材料。 */
  ignoreFolders: string[];

  includePdf: boolean;
  /** 索引时给每张图生成文字描述，让图片本身可被语义检索。
   *  代价很大（一张十几秒），默认关闭。 */
  describeImages: boolean;
  embedModel: string;
  indexDir: string;           // 空字符串 = 用默认（库之外）

  /** 监听库内文件增删改，防抖后自动增量更新索引。
   *  关掉就退回手动点按钮。 */
  autoIndex: boolean;

  /** 内部知识检索。开：严格依据笔记作答并强制引用；
   *  关：笔记只作为可选参考，模型可以结合自身知识自由回答。 */
  vaultRetrieval: boolean;

  // 高级
  topK: number;
  threshold: number;

  // 界面
  showRibbon: boolean;
  /** 用主页接管新标签页。默认关：会和 Beautitab 这类插件抢同一个空 leaf。 */
  newTabHome: boolean;
  /** 主页简洁模式：只留标题和搜索框 */
  homeMinimal: boolean;
}

export const DEFAULT_SETTINGS: KnowledgeAiSettings = {
  endpoint: "http://localhost:11434/v1",
  chatModel: "",
  apiKey: "",
  visionModel: "",
  embedEndpoint: "",

  uiLang: "auto",
  answerLang: "auto",

  scopeFolders: [],
  ignoreFolders: [],
  includePdf: true,
  describeImages: false,
  // 端点侧的嵌入模型名。bge-m3 多语言、质量好；
  // 想更快更小可换 nomic-embed-text（274 MB，英文更强）
  embedModel: "bge-m3",
  indexDir: "",

  autoIndex: true,
  vaultRetrieval: true,

  // 8 是早先跟 ~/bin/ai 对齐的值，偏紧：一道问题往往牵涉两三份材料，
  // 而同一份材料常占掉两三段，8 段经常只够覆盖一份半。
  // 提到 12 之后仍在各模型的上下文预算内（放不下时 trimToBudget 会兜住），
  // 笔记配额也从 4 涨到 6，能同时容下两三篇不同的笔记。
  topK: 12,
  // 0.5 是实测的分界：真正相关的段落在 0.60–0.64，
  // 完全无关的内容也能拿到 0.35–0.49。阈值定在 0.3 会把无关材料
  // 一起塞进去，模型要么被带偏，要么整段解释「这些跟你的问题无关」。
  threshold: 0.5,

  showRibbon: true,
  newTabHome: false,
  homeMinimal: false,
};
