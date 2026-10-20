// Release notes from the changesets CHANGELOG.md files (.github/workflows/release.yml).
// Usage: node release-notes.mjs <repo-root> <tag> [image@digest]
// Leads with the curated notes for the tag's minor version (docs/release-notes/<major>.<minor>.md)
// when they exist, then the newest "## <version>" section of every workspace package's
// CHANGELOG.md, without the "Updated dependencies" lines (every package moves together).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [root = ".", tag = "", image = ""] = process.argv.slice(2);
const sections = [];
for (const group of ["apps", "packages"]) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    const changelog = join(dir, name, "CHANGELOG.md");
    const pkg = join(dir, name, "package.json");
    if (!existsSync(changelog) || !existsSync(pkg)) continue;
    const text = readFileSync(changelog, "utf8");
    const match = /^## .+$\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
    if (!match) continue;
    const version = match[0].split("\n")[0].replace(/^## /, "");
    const body = match[1]
      .split("\n")
      .filter((l) => !/^\s*- Updated dependencies|^\s+- @psyche\/[^@\s]+@\S+$/.test(l))
      .join("\n")
      .replace(/^### [^\n]+\n+(?=### |(?![\s\S]))/gm, "")
      .trim();
    if (body)
      sections.push(`### ${JSON.parse(readFileSync(pkg, "utf8")).name} ${version}\n\n${body}`);
  }
}

const minor = /^v?(\d+)\.(\d+)\./.exec(tag);
const curatedFile = minor ? join(root, "docs/release-notes", `${minor[1]}.${minor[2]}.md`) : "";
const out = [];
if (curatedFile && existsSync(curatedFile)) {
  out.push(readFileSync(curatedFile, "utf8").trim(), "");
  if (sections.length) {
    out.push("<details><summary>Changes by package</summary>", "", sections.join("\n\n"), "");
    out.push("</details>", "");
  }
} else {
  out.push(`# Psyche ${tag}`, "");
  out.push(sections.length ? sections.join("\n\n") : "_No changesets in this release._", "");
}
if (image && !image.endsWith("@")) {
  out.push(
    "## Gateway image",
    "",
    "```",
    image,
    "```",
    "",
    "Verify the signature before pinning it in `deploy/.env`:",
    "",
    "```bash",
    `cosign verify ${image} \\`,
    "  --certificate-identity-regexp '^https://github.com/devmello/psyche/\\.github/workflows/release\\.yml@refs/tags/v' \\",
    "  --certificate-oidc-issuer https://token.actions.githubusercontent.com",
    "```",
    "",
    `For Docker Compose, download \`psyche-compose-${tag.replace(/^v/, "")}.tar.gz\` from this release: its \`docker-compose.yml\` defaults to this image by digest.`,
    "",
  );
}
out.push(
  "`SHA256SUMS` lists every attached file. macOS binaries are unsigned unless the release secrets were configured.",
);
process.stdout.write(`${out.join("\n")}\n`);
