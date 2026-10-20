/**
 * `pnpm docs:sync`: generates the site pages whose source lives elsewhere in the repository, so
 * there is one copy of each text.
 *
 * - `docs/guides/*.md` → `guides/` (`README.md` becomes the section index).
 * - `docs/release-notes/*.md` → `release-notes/`, plus an index, newest first.
 * - `apps/cli`'s command table → `reference/cli.md`.
 *
 * Links to another site page become site paths. Links to any other repository file become absolute
 * GitHub links (`scripts/check-links.mjs` checks that those files exist). The output is
 * git-ignored.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSpec } from "../../apps/cli/src/command.ts";
import { COMMANDS } from "../../apps/cli/src/commands/index.ts";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(site, "..");
export const GITHUB = "https://github.com/devmello/psyche";

/** A repository path (relative to the repo root) as a GitHub link. */
function githubLink(repoPath: string, anchor: string): string {
  const full = join(repo, repoPath);
  const kind = existsSync(full) && statSync(full).isDirectory() ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${repoPath}${anchor}`;
}

/** Repository Markdown files that are also site pages, as site paths. */
const SITE_PAGES: Record<string, string> = { "docs/guides/": "/guides/", "docs/release-notes/": "/release-notes/" };

function sitePath(repoPath: string): string | undefined {
  for (const [dir, base] of Object.entries(SITE_PAGES)) {
    if (!repoPath.startsWith(dir) || !repoPath.endsWith(".md")) continue;
    const name = repoPath.slice(dir.length, -".md".length);
    if (name.includes("/")) continue;
    return name === "README" ? base : `${base}${name}`;
  }
  return undefined;
}

/**
 * Rewrites the Markdown links of a file copied from `fromDir` (repo-relative): a link to another
 * page of the site becomes its site path, any other repository file a GitHub link. External and
 * anchor-only links are left alone.
 */
function rewriteLinks(text: string, fromDir: string): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return whole;
    const hash = target.indexOf("#");
    const path = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? "" : target.slice(hash);
    const repoPath = posix.normalize(posix.join(fromDir, path));
    if (repoPath.startsWith("..")) return whole;
    const page = sitePath(repoPath);
    return `](${page === undefined ? githubLink(repoPath, anchor) : `${page}${anchor}`})`;
  });
}

function generatedNote(source: string): string {
  return `\n::: tip Source\nThis page is generated from [\`${source}\`](${GITHUB}/blob/main/${source}); edit it there.\n:::\n`;
}

/** Inserts the note after the first H1 (or at the top); generated pages have no edit link. */
function withNote(text: string, source: string): string {
  const m = /^# .*$/m.exec(text);
  const body =
    m === null
      ? `${generatedNote(source)}\n${text}`
      : `${text.slice(0, m.index + m[0].length)}\n${generatedNote(source)}${text.slice(m.index + m[0].length)}`;
  return `---\neditLink: false\n---\n\n${body}`;
}

function copyDir(fromDir: string, toDir: string): string[] {
  const out = join(site, toDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files = readdirSync(join(repo, fromDir)).filter((f) => f.endsWith(".md")).sort();
  for (const f of files) {
    const source = posix.join(fromDir, f);
    const text = rewriteLinks(readFileSync(join(repo, source), "utf8"), fromDir);
    writeFileSync(join(out, f === "README.md" ? "index.md" : f), withNote(text, source));
  }
  return files;
}

// Guides.
copyDir("docs/guides", "guides");

// Release notes, newest first, with an index.
const notes = copyDir("docs/release-notes", "release-notes")
  .map((f) => f.replace(/\.md$/, ""))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const titleOf = (n: string) =>
  /^# (.*)$/m.exec(readFileSync(join(repo, "docs/release-notes", `${n}.md`), "utf8"))?.[1] ?? n;
writeFileSync(
  join(site, "release-notes", "index.md"),
  [
    "---",
    "title: Release notes",
    "editLink: false",
    "---",
    "",
    "# Release notes",
    "",
    "What changed in each release, newest first. Alphas are for testing; see the [security policy](/security/#reporting-a-vulnerability) for which versions get fixes.",
    "",
    ...notes.map((n) => `- [${titleOf(n)}](./${n})`),
    "",
  ].join("\n"),
);

// CLI reference from the command table.
function usage(c: CommandSpec): string {
  const args = (c.args ?? []).map((a) => {
    const name = `${a.name}${a.variadic === true ? "…" : ""}`;
    return a.required === true ? `<${name}>` : `[${name}]`;
  });
  return ["psyche", ...c.path, ...args, ...(Object.keys(c.options ?? {}).length > 0 ? ["[options]"] : [])].join(" ");
}
const escape = (s: string) => s.replace(/\|/g, "\\|");
const cli: string[] = [
  "---",
  "title: CLI reference",
  "editLink: false",
  "---",
  "",
  "# CLI reference",
  generatedNote("apps/cli/src/commands/index.ts"),
  "`psyche` talks to your Gateway as a paired device. Every command has `--help` and accepts `--json` for scripts. Commands that change security settings need the admin scope and, on a Gateway with a passkey or the helper's Touch ID key, fresh presence.",
  "",
  "| Command | What it does |",
  "| --- | --- |",
  ...COMMANDS.map((c) => `| [\`psyche ${c.path.join(" ")}\`](#${c.path.join("-")}) | ${escape(c.summary)} |`),
  "",
];
for (const c of COMMANDS) {
  cli.push(`## psyche ${c.path.join(" ")} {#${c.path.join("-")}}`, "", c.summary, "");
  if (c.description !== undefined && c.description !== c.summary) cli.push(c.description, "");
  cli.push("```", usage(c), "```", "");
  if ((c.args ?? []).length > 0) {
    cli.push("| Argument | Description |", "| --- | --- |");
    for (const a of c.args ?? []) cli.push(`| \`${a.name}\`${a.required === true ? "" : " (optional)"} | ${escape(a.description)} |`);
    cli.push("");
  }
  const opts = Object.entries(c.options ?? {});
  if (opts.length > 0) {
    cli.push("| Option | Description |", "| --- | --- |");
    for (const [name, o] of opts) {
      const flag = `--${name}${o.type === "string" ? " <value>" : ""}${o.short === undefined ? "" : `, -${o.short}`}`;
      const choices = o.choices === undefined ? "" : ` One of: ${o.choices.map((x) => `\`${x}\``).join(", ")}.`;
      cli.push(`| \`${flag}\` | ${escape(o.description)}${choices} |`);
    }
    cli.push("");
  }
}
mkdirSync(join(site, "reference"), { recursive: true });
writeFileSync(join(site, "reference", "cli.md"), `${cli.join("\n")}\n`);

const count = (d: string) => readdirSync(join(site, d)).length;
process.stdout.write(
  `docs:sync: ${count("guides")} guides, ${notes.length} release notes, ${COMMANDS.length} CLI commands (${relative(repo, site)})\n`,
);
