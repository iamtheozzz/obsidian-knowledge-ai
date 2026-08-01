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
  /** null = 没找到能用的图标，改画 letter */
  icon: string | null;
  /** 兜底的字母徽章：插件名首字 */
  letter: string;
}

/** app.commands 不在公开 API 里，但从 0.9 起就是这个形状，Templater 之类也照用 */
interface CommandsApi {
  commands: Record<string, Command>;
  executeCommandById(id: string): boolean;
}

interface RibbonItem {
  id: string;      // "插件id:标题"
  icon?: string;
}

interface Internals {
  commands?: CommandsApi;
  workspace?: { leftRibbon?: { items?: RibbonItem[] } };
  plugins?: { manifests?: Record<string, { name?: string }> };
}

function api(app: App): CommandsApi | null {
  const c = (app as App & Internals).commands;
  return c && typeof c.executeCommandById === "function" ? c : null;
}

/** 命令和 ribbon 都拿不到图标时，按所属插件兜底。
 *  核心插件的命令基本不设 icon，而它们的功能又太常见，值得单独列一份。 */
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

/**
 * 插件 id → 它在左侧 ribbon 上用的图标。
 *
 * 插件的「脸」几乎都挂在 ribbon 图标上：三方插件极少给命令设 icon
 * （icon 是 addCommand 的可选字段），但大多会加一个 ribbon 图标。
 *
 * leftRibbon.items 是非公开 API。项的形状是 {id, icon, title, ...}，
 * id 由 addRibbonIcon 拼成「插件id:标题」——这两点对着本机 Obsidian
 * 的实现核过。拿不到就整体回退到下面的兜底表。
 */
function ribbonIcons(app: App): Record<string, string> {
  const items = (app as App & Internals).workspace?.leftRibbon?.items;
  const out: Record<string, string> = {};
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const owner = it?.id?.split(":")[0];
    // 一个插件可能挂好几个 ribbon 图标，取第一个——没有更好的判据，
    // 而插件通常把最有代表性的那个放在最前
    if (owner && it.icon && !out[owner]) out[owner] = it.icon;
  }
  return out;
}

/** 命令名在注册时被 Obsidian 前缀成「插件名: 命令名」，manifest 拿不到时从这儿退一步 */
function letterOf(app: App, ownerId: string, cmdName: string): string {
  const manifest = (app as App & Internals).plugins?.manifests?.[ownerId];
  const src = manifest?.name || cmdName.split(":")[0] || ownerId;
  const ch = src.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

function toLite(app: App, cmd: Command, ribbon: Record<string, string>): CommandLite {
  const owner = cmd.id.split(":")[0];
  return {
    id: cmd.id,
    name: cmd.name,
    icon: cmd.icon ?? ribbon[owner] ?? FALLBACK_ICON[owner] ?? null,
    letter: letterOf(app, owner, cmd.name),
  };
}

/** 全部可执行命令，按名字排序，供设置页的下拉框用 */
export function listCommands(app: App): CommandLite[] {
  const c = api(app);
  if (!c) return [];
  const ribbon = ribbonIcons(app);
  return Object.values(c.commands)
    .map((cmd) => toLite(app, cmd, ribbon))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 查不到就返回 null——插件可能被卸载或停用了，那个格子直接不画，
 *  留一个点了没反应的图标比少一个更糟 */
export function getCommand(app: App, id: string): CommandLite | null {
  const cmd = id ? api(app)?.commands[id] : undefined;
  return cmd ? toLite(app, cmd, ribbonIcons(app)) : null;
}

export function runCommand(app: App, id: string): void {
  api(app)?.executeCommandById(id);
}
