// Node base-image pins across the repository (issue #295; security §11 "image digests").
//
//   node deploy/scripts/node-pins.mjs check [--latest]   every pin is node:<x.y.z>-<variant>@sha256:…
//                                                         and they agree; --latest also compares
//                                                         with nodejs.org's newest release of that
//                                                         major (network) and fails when behind
//   node deploy/scripts/node-pins.mjs latest              prints the newest release of the major
//   node deploy/scripts/node-pins.mjs update --version 24.22.1 [--files a,b]
//                                                         resolves each variant's digest on Docker
//                                                         Hub and rewrites every pin (network)
//
// After a Node security release: `update --version <patched>`, review the diff, then
// `check --latest`. The sandbox image (deploy/sandbox-image, S21) is listed too: coordinate its
// re-pin with docs/archive/status/s21.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
export const PIN_FILES = [
  "deploy/Dockerfile",
  "deploy/sandbox-image/Dockerfile",
  "deploy/sandbox-image/versions.json",
  "tests/integration/server-mode/Dockerfile",
];
const PIN = /node:(\d+(?:\.\d+){0,2})-([a-z0-9][a-z0-9.-]*?)@sha256:([0-9a-f]{64})/g;
const EXACT = /^\d+\.\d+\.\d+$/;

/** Every Node image pin in `text`. */
export function findPins(text) {
  return [...text.matchAll(PIN)].map((m) => ({
    ref: m[0],
    version: m[1],
    variant: m[2],
    digest: m[3],
  }));
}

/** Problems with a set of pins: floating versions, disagreeing versions. */
export function checkPins(byFile) {
  const problems = [];
  const versions = new Set();
  for (const [file, pins] of Object.entries(byFile)) {
    for (const p of pins) {
      if (!EXACT.test(p.version))
        problems.push(`${file}: ${p.ref.split("@")[0]} is not an exact version`);
      versions.add(p.version);
    }
  }
  if (versions.size > 1) problems.push(`pins disagree: ${[...versions].sort().join(", ")}`);
  return { problems, versions: [...versions] };
}

/** Newest release of `major` from nodejs.org's index. */
export async function latestRelease(major, fetchImpl = fetch) {
  const res = await fetchImpl("https://nodejs.org/dist/index.json");
  if (!res.ok) throw new Error(`nodejs.org: ${res.status}`);
  const list = await res.json();
  const hit = list.find((r) => String(r.version).startsWith(`v${major}.`));
  if (!hit) throw new Error(`no release of Node ${major}`);
  return String(hit.version).slice(1);
}

/** Manifest-list digest of library/node:<tag> on Docker Hub (anonymous pull token). */
export async function hubDigest(tag, fetchImpl = fetch) {
  const auth = await fetchImpl(
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull",
  );
  if (!auth.ok) throw new Error(`docker auth: ${auth.status}`);
  const { token } = await auth.json();
  const res = await fetchImpl(`https://registry-1.docker.io/v2/library/node/manifests/${tag}`, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${token}`,
      accept:
        "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
    },
  });
  const digest = res.headers.get("docker-content-digest");
  if (!res.ok || !digest?.startsWith("sha256:"))
    throw new Error(`node:${tag}: ${res.status} (not published yet?)`);
  return digest.slice("sha256:".length);
}

/** Rewrites every pin in `text` to `version`, with digests from `digestFor(tag)`. */
export async function repin(text, version, digestFor) {
  let out = text;
  for (const p of findPins(text)) {
    const tag = `${version}-${p.variant}`;
    out = out.replace(p.ref, `node:${tag}@sha256:${await digestFor(tag)}`);
  }
  return out;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  const files = (opt("--files")?.split(",") ?? PIN_FILES).map((f) => f.trim()).filter(Boolean);
  const read = (f) => readFileSync(join(ROOT, f), "utf8");
  if (cmd === "check") {
    const byFile = Object.fromEntries(files.map((f) => [f, findPins(read(f))]));
    const { problems, versions } = checkPins(byFile);
    for (const [f, pins] of Object.entries(byFile)) {
      for (const p of pins)
        process.stdout.write(
          `${f}: node:${p.version}-${p.variant}@sha256:${p.digest.slice(0, 12)}…\n`,
        );
    }
    if (rest.includes("--latest") && versions.length === 1) {
      const major = versions[0].split(".")[0];
      const latest = await latestRelease(major);
      if (latest !== versions[0])
        problems.push(`Node ${major} is at ${latest}; the pins are ${versions[0]}`);
    }
    for (const p of problems) process.stderr.write(`node-pins: ${p}\n`);
    process.exit(problems.length ? 1 : 0);
  }
  if (cmd === "latest") {
    process.stdout.write(`${await latestRelease(opt("--major") ?? "24")}\n`);
    return;
  }
  if (cmd === "update") {
    const version = opt("--version");
    if (!version || !EXACT.test(version)) throw new Error("update needs --version x.y.z");
    const cache = new Map();
    const digestFor = async (tag) => {
      if (!cache.has(tag)) cache.set(tag, await hubDigest(tag));
      return cache.get(tag);
    };
    for (const f of files) {
      const before = read(f);
      const after = await repin(before, version, digestFor);
      if (after !== before) {
        writeFileSync(join(ROOT, f), after);
        process.stdout.write(`updated ${f}\n`);
      }
    }
    return;
  }
  throw new Error(
    "commands: check [--latest], latest [--major N], update --version x.y.z [--files a,b]",
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`node-pins: ${err.message}\n`);
    process.exit(2);
  });
}
