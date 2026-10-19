// Release notes from the changesets CHANGELOG.md files (.github/workflows/release.yml).
// Usage: node release-notes.mjs <repo-root> <tag> [image@digest]
// Takes the newest "## <version>" section of every workspace package's CHANGELOG.md.
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
    const body = match[1].trim();
    if (body)
      sections.push(`### ${JSON.parse(readFileSync(pkg, "utf8")).name} ${version}\n\n${body}`);
  }
}

const out = [`# Psyche ${tag}`, ""];
out.push(sections.length ? sections.join("\n\n") : "_No changesets in this release._", "");
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
  );
}
out.push(
  "`SHA256SUMS` lists every attached file. macOS binaries are unsigned unless the release secrets were configured.",
);
process.stdout.write(`${out.join("\n")}\n`);
