#!/usr/bin/env -S node --experimental-strip-types
/**
 * `pnpm check:secrets`: the secret-leak checker as a CI gate (security §15.4 items 4 and 7).
 *
 *   pnpm check:secrets                    # tracked files + captures in $PSYCHE_CAPTURE_DIR
 *   pnpm check:secrets --captures <dir>   # only the JSONL captures written by tests
 *   pnpm check:secrets --repo             # only tracked files
 *   pnpm check:secrets --json             # machine-readable report
 *   pnpm check:secrets --captures <dir> --require-captures   # fail if no captures were written
 *
 * Captures: every model-visible value recorded with `captureModelVisible` while
 * `PSYCHE_CAPTURE_DIR` was set, scanned for fixture secrets and card / ID / key patterns.
 * Tracked files: fixture secret values may appear only in the registry itself (tests read them
 * through `fixtureSecret()`), and pattern hits only in the files listed in `REPO_ALLOW`. Output
 * names files, lines and kinds, never values. Exit code 1 on any hit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { type Capture, describeLeak, type Leak, scanCaptures } from "../capture.ts";
import { findPatterns, type PatternKind } from "../secret-patterns.ts";
import { fixtureSecretSet } from "../secret-registry.ts";

/** Tracked files allowed to contain pattern-shaped samples or fixture values, with the reason. */
export const REPO_ALLOW: { path: string; kinds: "all" | PatternKind[]; why: string }[] = [
  {
    path: "tests/fixtures/secrets/registry.json",
    kinds: "all",
    why: "the registry of fake secrets and pattern samples",
  },
  {
    path: "docs/agent/research/teaching-loop.md",
    kinds: ["card"],
    why: "cited help-center URLs end in long numeric article ids (e.g. Superhuman's), not cards",
  },
];

const SKIP_PATH =
  /(^|\/)(pnpm-lock\.yaml|generated\/|node_modules\/)|\.(png|jpe?g|gif|pdf|ico|icns|woff2?|zip|gz)$/i;

export interface RepoHit {
  file: string;
  line: number;
  kind: string;
  label?: string;
}

export function scanRepo(root: string): RepoHit[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && !SKIP_PATH.test(f));
  const secrets = fixtureSecretSet();
  const hits: RepoHit[] = [];
  for (const file of files) {
    const allow = REPO_ALLOW.find((a) => a.path === file);
    if (allow?.kinds === "all") continue;
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (text.includes("\0")) continue; // binary
    const lineOf = lineIndex(text);
    for (const m of secrets.find(text)) {
      hits.push({ file, line: lineOf(m.offset), kind: "fixture_secret_inline", label: m.label });
    }
    for (const p of findPatterns(text, allow?.kinds === undefined ? [] : allow.kinds)) {
      hits.push({ file, line: lineOf(p.offset), kind: p.kind });
    }
  }
  return hits;
}

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function readCaptures(dir: string): Capture[] {
  if (!existsSync(dir)) return [];
  const out: Capture[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const c = JSON.parse(line) as Capture;
      out.push({ ...c, where: c.where === undefined ? f : `${f}: ${c.where}` });
    }
  }
  return out;
}

function displayPath(root: string, p: string): string {
  const rel = relative(root, p);
  return rel.startsWith("..") ? p : rel || ".";
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const onlyRepo = argv.includes("--repo");
  const ci = argv.indexOf("--captures");
  const captureDir = ci >= 0 ? argv[ci + 1] : process.env.PSYCHE_CAPTURE_DIR;
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  const repoHits = ci >= 0 ? [] : scanRepo(root);
  const captures =
    onlyRepo || captureDir === undefined || captureDir === "" ? [] : readCaptures(captureDir);
  if (argv.includes("--require-captures") && captures.length === 0) {
    process.stderr.write(
      "check:secrets: no captures found; did the tests run with PSYCHE_CAPTURE_DIR?\n",
    );
    return 1;
  }
  const leaks: Leak[] = scanCaptures(captures);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: repoHits.length + leaks.length === 0, repoHits, leaks }, null, 2)}\n`,
    );
  } else {
    for (const h of repoHits) {
      process.stdout.write(`${h.file}:${h.line}: ${h.kind}${h.label ? ` ${h.label}` : ""}\n`);
    }
    for (const l of leaks) process.stdout.write(`capture: ${describeLeak(l)}\n`);
    const scanned = [
      ci >= 0 ? null : "tracked files",
      captureDir && !onlyRepo ? `captures in ${displayPath(root, captureDir)}` : null,
    ].filter(Boolean);
    process.stdout.write(
      repoHits.length + leaks.length === 0
        ? `check:secrets: no leaks (${scanned.join(", ")})\n`
        : `check:secrets: ${repoHits.length + leaks.length} hit(s); values are never printed\n`,
    );
  }
  return repoHits.length + leaks.length === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main(process.argv.slice(2)));
}
