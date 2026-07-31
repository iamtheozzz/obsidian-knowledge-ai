/**
 * 忽略规则。索引期和查询期共用同一份判定，避免两边各写一套后不一致。
 *
 * 单独成文件是为了断开环依赖：indexer 依赖 store，而 store 在查询期
 * 也要用这个判定，放在任何一方都会让两者互相 import。
 */

/**
 * 这个路径是否落在被忽略的文件夹里。
 *
 * 按路径段比较，不用 startsWith 裸比——否则填 "Eval" 会连
 * "Evaluation/" 一起挡掉。填单个文件的完整路径也支持，
 * 因为想藏起来的往往就是某一个文件而不是整个目录。
 */
export function isIgnored(filePath: string, ignoreFolders: string[]): boolean {
  if (!ignoreFolders?.length) return false;
  const p = filePath.replace(/^\/+/, "");
  return ignoreFolders.some((raw) => {
    const d = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!d) return false;
    return p === d || p.startsWith(d + "/");
  });
}

/** 去掉空行和首尾斜杠，供设置页写入前统一格式 */
export function normalizeIgnoreList(raw: string[]): string[] {
  return raw
    .map((s) => s.trim().replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
}
