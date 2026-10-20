// Renders the release copy of deploy/docker-compose.yml (security §11: "the published Compose
// file pins image digests"; issue #296). The gateway service defaults to the release's image by
// digest, and its `build:` block (which needs a checkout) is dropped. Every other service is
// already pinned by digest in the repository file; this refuses a file where one is not.
//
// Usage: node render-compose.mjs <docker-compose.yml> <ghcr.io/…/psyche-gateway:<version>@sha256:…>
// Prints the rendered file.
import { readFileSync } from "node:fs";

const PINNED = /^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

export function renderCompose(text, imageRef) {
  if (!PINNED.test(imageRef)) throw new Error(`image must be pinned by digest: ${imageRef}`);
  const lines = text.split("\n");
  const out = [];
  let replaced = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s+image: \$\{PSYCHE_IMAGE:-[^}]+\}\s*$/.test(line)) {
      out.push(line.replace(/\$\{PSYCHE_IMAGE:-[^}]+\}/, `\${PSYCHE_IMAGE:-${imageRef}}`));
      replaced++;
      // Drop the gateway's build block: the release file pulls the signed image.
      if (/^\s+build:\s*$/.test(lines[i + 1] ?? "")) {
        const indent = (lines[i + 1].match(/^\s*/) ?? [""])[0].length;
        i++;
        while (i + 1 < lines.length && (lines[i + 1].match(/^\s*/) ?? [""])[0].length > indent) i++;
      }
      continue;
    }
    out.push(line);
  }
  if (replaced !== 1)
    throw new Error(`expected one \${PSYCHE_IMAGE:-…} image line, found ${replaced}`);
  const rendered = out
    .join("\n")
    .replace(
      /# Never an unpinned `latest`[\s\S]*?\(deploy\/scripts\/render-compose\.mjs\)\.\n/,
      "# Release file: the Gateway image is pinned by digest (set PSYCHE_IMAGE to override).\n",
    );
  for (const m of rendered.matchAll(/^\s+image:\s*(\S+)\s*$/gm)) {
    const ref = m[1].replace(/^\$\{PSYCHE_IMAGE:-(.+)\}$/, "$1");
    if (!PINNED.test(ref)) throw new Error(`unpinned image in the release compose file: ${ref}`);
  }
  return rendered;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [file, ref] = process.argv.slice(2);
  if (!file || !ref) {
    process.stderr.write(
      "usage: node render-compose.mjs <docker-compose.yml> <image@sha256:digest>\n",
    );
    process.exit(2);
  }
  try {
    process.stdout.write(renderCompose(readFileSync(file, "utf8"), ref));
  } catch (err) {
    process.stderr.write(`render-compose: ${err.message}\n`);
    process.exit(1);
  }
}
