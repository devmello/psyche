/**
 * `pnpm i18n:check` (A12): user-facing text in the kit and the web app comes from the message
 * catalogue (`packages/ui/src/i18n/messages`), never from string literals in JSX.
 *
 * Fails on:
 * - **hard-coded strings**: letters in JSX text, in user-facing JSX attributes (`aria-label`,
 *   `title`, `placeholder`, `label`, `description`, …), in string expressions rendered as JSX
 *   children, and in `toast()` messages — above the file's count in the shrink-only baseline
 *   (`scripts/i18n-baseline.json`, while the extraction lands screen group by screen group);
 * - **missing ids**: a `t("id")` whose id isn't in the English catalogue, or a `t(`prefix.${x}`)`
 *   whose prefix matches no id.
 *
 * Exempt: text inside `<code>`, `<kbd>`, `<pre>` and `<samp>`; a line marked `i18n-ignore` (on it
 * or the line above, with the reason); stories, fixtures and tests.
 *
 * `pnpm i18n:check --update` rewrites the baseline after an extraction; it refuses to raise any
 * file's count. docs/guides/translating.md has the details.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { en } from "../packages/ui/src/i18n/messages/index.ts";

const ROOT = join(import.meta.dirname, "..");
const SCAN = ["packages/ui/src", "apps/web/src"];
const BASELINE = join(ROOT, "scripts/i18n-baseline.json");

const TEXT_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "placeholder",
  "alt",
  "label",
  "description",
  "hint",
  "caption",
  "tooltip",
  "heading",
  "subtitle",
  "emptyText",
  "confirmLabel",
  "cancelLabel",
  "actionLabel",
]);
const CODE_TAGS = new Set(["code", "kbd", "pre", "samp"]);
const LETTER = /\p{L}/u;

interface Finding {
  file: string;
  line: number;
  col: number;
  kind: "jsx-text" | "attribute" | "expression" | "toast" | "missing-id";
  text: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "fixtures" || entry.name === "stories")
        continue;
      walkFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(stories|test)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const ids = new Set(Object.keys(en));

function scan(path: string): Finding[] {
  const source = readFileSync(path, "utf8");
  const file = relative(ROOT, path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const ignored = (line: number) =>
    (lines[line] ?? "").includes("i18n-ignore") || (lines[line - 1] ?? "").includes("i18n-ignore");
  const add = (node: ts.Node, kind: Finding["kind"], text: string) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (kind !== "missing-id" && ignored(line)) return;
    findings.push({ file, line: line + 1, col: character + 1, kind, text: text.trim() });
  };

  /** String literals in an expression that render as text (not call arguments or keys). */
  const literalsIn = (expr: ts.Node, kind: Finding["kind"]) => {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) return;
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
        // `a === "x" ? …`: compare operands aren't shown; only the result branches are.
        if (
          n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          visit(n.right);
          if (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) visit(n.left);
        }
        return;
      }
      if (ts.isConditionalExpression(n)) {
        visit(n.whenTrue);
        visit(n.whenFalse);
        return;
      }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        if (LETTER.test(n.text)) add(n, kind, n.text);
        return;
      }
      if (ts.isTemplateExpression(n)) {
        const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ");
        if (LETTER.test(parts)) add(n, kind, n.getText(sf));
        for (const span of n.templateSpans) visit(span.expression);
        return;
      }
      if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) visit(n.expression);
    };
    visit(expr);
  };

  const inCodeTag = (node: ts.Node): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && CODE_TAGS.has(p.openingElement.tagName.getText(sf))) return true;
    }
    return false;
  };

  const checkId = (call: ts.CallExpression) => {
    const arg = call.arguments[0];
    if (arg === undefined) return;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      if (!ids.has(arg.text)) add(arg, "missing-id", arg.text);
    } else if (ts.isTemplateExpression(arg)) {
      const prefix = arg.head.text;
      if (prefix === "" || ![...ids].some((id) => id.startsWith(prefix)))
        add(arg, "missing-id", arg.getText(sf));
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (LETTER.test(node.text) && !inCodeTag(node)) add(node, "jsx-text", node.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (TEXT_ATTRS.has(name) && init) {
        if (ts.isStringLiteral(init)) {
          if (LETTER.test(init.text)) add(init, "attribute", `${name}="${init.text}"`);
        } else if (ts.isJsxExpression(init) && init.expression) {
          literalsIn(init.expression, "attribute");
        }
      }
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      if (!inCodeTag(node)) literalsIn(node.expression, "expression");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      const obj =
        ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          ? callee.expression.text
          : "";
      if (name === "t") checkId(node);
      if ((name === "toast" || obj === "toast") && node.arguments[0])
        literalsIn(node.arguments[0], "toast");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

const files = SCAN.flatMap((d) => walkFiles(join(ROOT, d))).sort();
const all = files.flatMap(scan);
const hardCoded = new Map<string, Finding[]>();
const missing: Finding[] = [];
for (const f of all) {
  if (f.kind === "missing-id") missing.push(f);
  else hardCoded.set(f.file, [...(hardCoded.get(f.file) ?? []), f]);
}

const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
// `--init` writes the first baseline, and only while it is empty.
const init = process.argv.includes("--init") && Object.keys(baseline).length === 0;
const update = init || process.argv.includes("--update");
const verbose = process.argv.includes("--verbose");
const over: string[] = [];
const shrunk: string[] = [];
for (const file of new Set([...hardCoded.keys(), ...Object.keys(baseline)])) {
  const count = hardCoded.get(file)?.length ?? 0;
  const allowed = baseline[file] ?? 0;
  if (count > allowed) over.push(file);
  else if (count < allowed) shrunk.push(file);
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const print = (f: Finding) =>
  console.error(
    `  ${f.file}:${f.line}:${f.col}  ${f.kind}  ${JSON.stringify(f.text.slice(0, 80))}`,
  );

let failed = false;
if (missing.length > 0) {
  failed = true;
  console.error(`✗ ${missing.length} t() id(s) missing from the English catalogue:`);
  missing.forEach(print);
}
if (over.length > 0 && !init) {
  failed = true;
  console.error("✗ Hard-coded user-facing strings (use t() and a catalogue id):");
  for (const file of over) {
    const found = hardCoded.get(file) ?? [];
    console.error(`  ${file}: ${found.length} (baseline ${baseline[file] ?? 0})`);
    found.forEach(print);
  }
}

if (update) {
  if (over.length > 0 && !init) {
    console.error("✗ --update never raises a file's count; extract the new strings instead.");
    process.exit(1);
  }
  const next: Record<string, number> = {};
  for (const [file, found] of [...hardCoded.entries()].sort(([a], [b]) => a.localeCompare(b)))
    next[file] = found.length;
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  out(
    `Baseline updated: ${Object.keys(next).length} files, ${all.length - missing.length} strings left.`,
  );
} else if (shrunk.length > 0) {
  out(
    `${shrunk.length} file(s) are below their baseline; run \`pnpm i18n:check --update\` to lock that in.`,
  );
}
if (verbose) for (const found of hardCoded.values()) found.forEach(print);

const left = [...hardCoded.values()].reduce((n, f) => n + f.length, 0);
if (failed && !init) process.exit(1);
out(
  `✓ i18n: ${ids.size} catalogue ids, ${files.length} files scanned, ${left} hard-coded strings left in the baseline.`,
);
