#!/usr/bin/env node
// `pnpm docs:check` (after `vitepress build`, which already fails on dead links between site
// pages): every link into this repository on GitHub (`…/blob/main/<path>`, `…/tree/main/<path>`)
// must name a file or directory that exists, so the site cannot point owners at moved or deleted
// documents. Offline; no network.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(site, "../..");
const LINK = /https:\/\/github\.com\/devmello\/psyche\/(blob|tree)\/main\/([^\s)#?"'`>]+)/g;

function* markdown(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "cache") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* markdown(full);
    else if (name.endsWith(".md") || name.endsWith(".mts")) yield full;
  }
}

const broken = [];
let checked = 0;
for (const file of markdown(site)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LINK)) {
    checked += 1;
    const path = decodeURIComponent(m[2]).replace(/\/$/, "");
    const full = join(repo, path);
    const ok =
      existsSync(full) &&
      (m[1] === "tree" ? statSync(full).isDirectory() : statSync(full).isFile());
    if (!ok) broken.push(`${relative(repo, file)}: ${m[0]}`);
  }
}
if (broken.length > 0) {
  process.stderr.write(
    `docs:check: ${broken.length} broken repository link(s):\n${broken.map((b) => `  ${b}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(`docs:check: ${checked} repository links OK\n`);
