// Repository checks before a release tag (roadmap M3; docs/status/s22.md "First release").
// The release workflow's deploy smoke runs it first; run it by hand before tagging:
//
//   node deploy/scripts/release-preflight.mjs [--root <repo>]
//
// Fails (exit 1) on:
//   cooldown      pnpm-workspace.yaml `minimumReleaseAge` below 1440 minutes: dependencies younger
//                 than 24 h could enter the lockfile (DEP-11, supply chain)
//   node-pins     a floating or disagreeing Node base image (#295)
//   compose       the release Compose file would carry an unpinned image (#296)
//   update-policy deploy/update-policy.json minimumVersion is not x.y.z
//   sandbox-signer deploy/sandbox-image/versions.json's signer regexp would not match this
//                 repository's release.yml tag runs (cosign verify would fail)
// Warns (exit 0) on:
//   release-keys  no update-manifest key embedded in the desktop: installed apps will not
//                 auto-update to this release (security §11)
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPins, findPins, PIN_FILES } from "./node-pins.mjs";
import { renderCompose } from "./render-compose.mjs";

export const MIN_RELEASE_AGE_MINUTES = 1440;

export function preflight(root) {
  const read = (f) => readFileSync(join(root, f), "utf8");
  const results = [];
  const add = (id, status, message) => results.push({ id, status, message });

  const ws = read("pnpm-workspace.yaml");
  const age = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(ws);
  if (!age)
    add(
      "cooldown",
      "fail",
      "pnpm-workspace.yaml has no minimumReleaseAge (24 h dependency cool-down)",
    );
  else if (Number(age[1]) < MIN_RELEASE_AGE_MINUTES) {
    add(
      "cooldown",
      "fail",
      `minimumReleaseAge is ${age[1]} minutes; the release needs at least ${MIN_RELEASE_AGE_MINUTES} (24 h)`,
    );
  } else add("cooldown", "ok", `minimumReleaseAge ${age[1]} minutes`);

  const byFile = Object.fromEntries(PIN_FILES.map((f) => [f, findPins(read(f))]));
  const pins = checkPins(byFile);
  add(
    "node-pins",
    pins.problems.length ? "fail" : "ok",
    pins.problems.join("; ") || `Node ${pins.versions.join(", ")} everywhere`,
  );

  try {
    renderCompose(
      read("deploy/docker-compose.yml"),
      `ghcr.io/x/psyche-gateway:0.0.0@sha256:${"0".repeat(64)}`,
    );
    add("compose", "ok", "the release Compose file pins every image");
  } catch (err) {
    add("compose", "fail", err.message);
  }

  try {
    const min = JSON.parse(read("deploy/update-policy.json")).minimumVersion;
    add("update-policy", /^\d+\.\d+\.\d+$/.test(min) ? "ok" : "fail", `minimumVersion ${min}`);
  } catch (err) {
    add("update-policy", "fail", `deploy/update-policy.json: ${err.message}`);
  }

  try {
    const v = JSON.parse(read("deploy/sandbox-image/versions.json"));
    const re = new RegExp(v.signing.certificateIdentityRegexp);
    const sample =
      "https://github.com/devmello/psyche/.github/workflows/release.yml@refs/tags/v1.0.0";
    add(
      "sandbox-signer",
      re.test(sample) ? "ok" : "fail",
      re.test(sample) ? "matches release.yml tag runs" : `does not match ${sample}`,
    );
  } catch (err) {
    add("sandbox-signer", "fail", `deploy/sandbox-image/versions.json: ${err.message}`);
  }

  const keys = read("apps/desktop/src/main/release-keys.ts");
  const embedded = (keys.match(/keyId:\s*"[0-9a-f]{16}"/g) ?? []).length;
  add(
    "release-keys",
    embedded ? "ok" : "warn",
    embedded
      ? `${embedded} update-manifest key(s) embedded`
      : "no update-manifest key embedded: installed apps will not auto-update to this release (node deploy/scripts/update-manifest.mjs keygen)",
  );
  return results;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf("--root");
  const root = resolve(
    i === -1 ? join(fileURLToPath(new URL(".", import.meta.url)), "../..") : process.argv[i + 1],
  );
  const results = preflight(root);
  for (const r of results) process.stdout.write(`${r.status.padEnd(4)}  ${r.id}: ${r.message}\n`);
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}
