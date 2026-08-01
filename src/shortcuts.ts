import type { App, Command } from "obsidian";

/**
 * 主页搜索框下面那排图标。每个格子绑一条命令——命令是 Obsidian 里
 * 唯一稳定的「插件入口」：插件本身没有可调用的公开句柄，而命令有 id、
 * 有名字、多数还自带图标，用户在设置里能直接按名字挑。
 */

/** 主页图标位数。四个是给定的：再多一行就压到「最近打开」上面了 */
export const SHORTCUT_SLOTS = 4;

export interface CommandLite {
  id: string;
  name: string;
  icon: string;
}

/** app.commands 不在公开 API 里，但从 0.9 起就是这个形状，Templater 之类也照用 */
interface CommandsApi {
  commands: Record<string, Command>;
  executeCommandById(id: string): boolean;
}

function api(app: App): CommandsApi | null {
  const c = (app as App & { commands?: CommandsApi }).commands;
  return c && typeof c.executeCommandById === "function" ? c : null;
}

/** 命令没写 icon 时按所属插件兜底。核心插件基本都不给自己的命令设图标，
 *  全兜成同一个问号会让四个格子长得一模一样，等于没有图标。 */
const FALLBACK_ICON: Record<string, string> = {
  "lark-knowledge-ai": "wand-sparkles",
  "switcher": "search",
  "global-search": "search",
  "graph": "git-fork",
  "command-palette": "terminal",
  "canvas": "layout-dashboard",
  "daily-notes": "calendar-days",
  "bookmarks": "bookmark",
  "file-explorer": "folder",
  "random-note": "dice",
  "outline": "list",
  "tag-pane": "tags",
  "templates": "copy",
  "editor": "pencil",
  "workspace": "layout",
  "app": "gear",
  "theme": "palette",
};

function iconOf(cmd: Command): string {
  if (cmd.icon) return cmd.icon;
  const owner = cmd.id.split(":")[0];
  return FALLBACK_ICON[owner] ?? "puzzle";
}

/** 全部可执行命令，按名字排序，供设置页的下拉框用 */
export function listCommands(app: App): CommandLite[] {
  const c = api(app);
  if (!c) return [];
  return Object.values(c.commands)
    .map((cmd) => ({ id: cmd.id, name: cmd.name, icon: iconOf(cmd) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 查不到就返回 null——插件可能被卸载或停用了，那个格子直接不画，
 *  留一个点了没反应的图标比少一个更糟 */
export function getCommand(app: App, id: string): CommandLite | null {
  const cmd = id ? api(app)?.commands[id] : undefined;
  return cmd ? { id: cmd.id, name: cmd.name, icon: iconOf(cmd) } : null;
}

export function runCommand(app: App, id: string): void {
  api(app)?.executeCommandById(id);
}
