// Renders the Homebrew cask and formula from a release (.github/workflows/publish.yml).
// Usage: node homebrew.mjs <version without v> <SHA256SUMS> <out-dir>
// Writes <out-dir>/Casks/psyche.rb and <out-dir>/Formula/psyche-cli.rb (the tap's layout).
// Every {{SHA256:<file>}} must have a line in SHA256SUMS; a missing asset fails the render.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) sums.set(basename(m[2]), m[1]);
  }
  return sums;
}

export function render(template, version, sums) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`version must look like 1.2.3, got ${version}`);
  }
  const withVersion = template.replaceAll("{{VERSION}}", version);
  const missing = [];
  const out = withVersion.replace(/\{\{SHA256:([^}]+)\}\}/g, (_, file) => {
    const sum = sums.get(file);
    if (!sum) missing.push(file);
    return sum ?? "";
  });
  if (missing.length) throw new Error(`SHA256SUMS has no entry for: ${missing.join(", ")}`);
  if (/\{\{[^}]*\}\}/.test(out)) throw new Error("unrendered placeholder left in the template");
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [version, sumsFile, outDir] = process.argv.slice(2);
  if (!version || !sumsFile || !outDir) {
    console.error("usage: node homebrew.mjs <version> <SHA256SUMS> <out-dir>");
    process.exit(2);
  }
  const sums = parseSums(readFileSync(sumsFile, "utf8"));
  for (const [tmpl, dest] of [
    ["psyche.rb.tmpl", "Casks/psyche.rb"],
    ["psyche-cli.rb.tmpl", "Formula/psyche-cli.rb"],
  ]) {
    const text = render(readFileSync(join(here, "../homebrew", tmpl), "utf8"), version, sums);
    mkdirSync(dirname(join(outDir, dest)), { recursive: true });
    writeFileSync(join(outDir, dest), text);
  }
}
