import type { CodeHighlighterPlugin } from "streamdown";

/**
 * Shiki 4 code highlighting for Streamdown, on Shiki's JavaScript regex engine: no WASM, so it
 * runs under the shells' `script-src 'self'` CSP. Languages load on first use; unknown languages
 * render as plain text.
 */

type HighlighterCore = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;
type LangLoader = () => Promise<{ default: unknown }>;

const LANGS: Record<string, LangLoader> = {
  bash: () => import("shiki/dist/langs/bash.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
};

const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  md: "markdown",
  py: "python",
  yml: "yaml",
};

const THEMES = ["github-light", "github-dark"] as const;

let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function getCore(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/dist/themes/github-light.mjs"),
        import("shiki/dist/themes/github-dark.mjs"),
      ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return core;
}

export function resolveLanguage(lang: string): string | null {
  const id = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return id in LANGS ? id : null;
}

async function highlightAsync(code: string, lang: string) {
  const h = await getCore();
  if (!loaded.has(lang)) {
    const mod = await (LANGS[lang] as LangLoader)();
    await h.loadLanguage(mod.default as Parameters<HighlighterCore["loadLanguage"]>[0]);
    loaded.add(lang);
  }
  const result = h.codeToTokens(code, {
    lang,
    themes: { light: THEMES[0], dark: THEMES[1] },
    defaultColor: false,
  });
  return {
    tokens: result.tokens.map((line) =>
      line.map((t) => ({
        content: t.content,
        ...(t.htmlStyle ? { htmlStyle: t.htmlStyle as Record<string, string> } : {}),
      })),
    ),
  };
}

export const psycheCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => Object.keys(LANGS),
  getThemes: () => [THEMES[0], THEMES[1]],
  supportsLanguage: (language) => resolveLanguage(language) !== null,
  highlight(options, callback) {
    const lang = resolveLanguage(options.language);
    if (lang === null) return null;
    if (options.isIncomplete === true) return null;
    void highlightAsync(options.code, lang)
      .then((r) => callback?.(r))
      .catch(() => {});
    return null;
  },
};
