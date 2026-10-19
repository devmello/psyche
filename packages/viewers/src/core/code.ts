import { extensionOf } from "./registry.ts";

/**
 * Code highlighting with Shiki 4 (ADR-013): the JavaScript RegExp engine (no WASM download) and
 * the web bundle, whose grammars load lazily per language. One shared highlighter per process.
 */

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  lua: "lua",
  r: "r",
  dockerfile: "dockerfile",
  makefile: "makefile",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  vue: "vue",
  svelte: "svelte",
  json: "json",
  jsonl: "json",
  geojson: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
};

/** Shiki language id for a file name, or "text". */
export function languageFor(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return EXT_LANG[extensionOf(name) ?? ""] ?? "text";
}

export interface CodeToken {
  /** Offset into the source text. */
  from: number;
  to: number;
  color?: string;
  fontStyle?: number;
}

export const CODE_THEMES = { light: "github-light", dark: "github-dark" } as const;

type Highlighter = {
  loadLanguage(lang: string): Promise<void>;
  getLoadedLanguages(): string[];
  codeToTokensBase(
    code: string,
    opts: { lang: string; theme: string; tokenizeTimeLimit?: number },
  ): { content: string; offset: number; color?: string; fontStyle?: number }[][];
};

let highlighter: Promise<Highlighter> | undefined;

async function getHighlighter(): Promise<Highlighter> {
  highlighter ??= (async () => {
    const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/bundle/web"),
      import("shiki/engine/javascript"),
    ]);
    return (await createHighlighter({
      themes: [CODE_THEMES.light, CODE_THEMES.dark],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })) as unknown as Highlighter;
  })();
  return highlighter;
}

/** Highlighting above this size is skipped (plain text stays fast and responsive). */
export const MAX_HIGHLIGHT_CHARS = 500_000;

/** Token colors for `code`; an empty list for plain text, unknown languages or huge files. */
export async function highlightTokens(
  code: string,
  lang: string,
  theme: "light" | "dark" = "light",
): Promise<CodeToken[]> {
  if (lang === "text" || code.length > MAX_HIGHLIGHT_CHARS) return [];
  const hl = await getHighlighter();
  try {
    if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(lang);
  } catch {
    return [];
  }
  const out: CodeToken[] = [];
  for (const line of hl.codeToTokensBase(code, {
    lang,
    theme: CODE_THEMES[theme],
    // Shiki stops tokenizing a line after this long and leaves the rest uncolored; the first
    // line pays for regex compilation, so allow more than the 500 ms default.
    tokenizeTimeLimit: 2000,
  })) {
    for (const t of line) {
      if (t.content.length === 0) continue;
      const tok: CodeToken = { from: t.offset, to: t.offset + t.content.length };
      if (t.color !== undefined) tok.color = t.color;
      if (t.fontStyle !== undefined && t.fontStyle > 0) tok.fontStyle = t.fontStyle;
      out.push(tok);
    }
  }
  return out;
}
