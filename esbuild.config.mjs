import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";
import os from "os";

const prod = process.argv[2] === "production";

// 开发时直接把产物写进库里的插件目录，改完 reload 即生效。
// 源码留在本仓库，不混进笔记库。
const VAULT_PLUGIN_DIR = path.join(
  os.homedir(),
  "Documents/Obsidian/.obsidian/plugins/knowledge-ai"
);
const outdir = prod ? "." : VAULT_PLUGIN_DIR;

if (!prod) {
  fs.mkdirSync(outdir, { recursive: true });
  for (const f of ["manifest.json", "styles.css"]) {
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(outdir, f));
  }
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian 在运行时提供这些，打进来会重复且体积暴涨
  external: [
    "obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab",
    "@codemirror/commands", "@codemirror/language", "@codemirror/lint",
    "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(outdir, "main.js"),
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
  console.log(`[knowledge-ai] watching → ${outdir}`);
}
