// Signed update manifests for the desktop updater (security §11; apps/desktop/src/main/update-manifest.ts).
//
//   node update-manifest.mjs keygen <private-key.pem>      new Ed25519 release key (0600); prints
//                                                            {keyId, publicKey} for release-keys.ts
//   node update-manifest.mjs build --release 1.2.3 --base <url>/ [--minimum 1.0.0]
//        [--image gateway=ghcr.io/…@sha256:…] <artifacts…>   prints update-manifest.json
//   node update-manifest.mjs sign <update-manifest.json>   writes <file>.sig with the key in
//                                                            PSYCHE_RELEASE_SIGNING_KEY (PEM)
//   node update-manifest.mjs verify <update-manifest.json> <publicKey-base64>
//
// The signature covers the manifest file's exact bytes: `build` output is written once and never
// reformatted after signing.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const FORMAT = "psyche-update-manifest";
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function keyIdOf(raw) {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function rawPublicKey(keyObject) {
  const pub = keyObject.type === "public" ? keyObject : createPublicKey(keyObject);
  return Buffer.from(pub.export({ format: "jwk" }).x, "base64url");
}

export function artifactOf(path) {
  const name = basename(path);
  const m = /^Psyche-(.+?)-(?:darwin-)?(arm64|x64)\.(zip|dmg)$/.exec(name);
  if (!m) return null;
  const bytes = readFileSync(path);
  return {
    name,
    platform: "darwin",
    arch: m[2],
    kind: m[3],
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: statSync(path).size,
  };
}

export function buildManifest({
  release,
  minimum = "0.0.0",
  base,
  images = {},
  files,
  now = new Date(),
}) {
  if (!VERSION.test(release) || !VERSION.test(minimum))
    throw new Error("versions must look like 1.2.3");
  if (!/^https:\/\/.+\/$/.test(base)) throw new Error("--base must be an https URL ending in /");
  const artifacts = files.map(artifactOf).filter(Boolean);
  if (!artifacts.some((a) => a.kind === "zip"))
    throw new Error("no Psyche-<version>-darwin-<arch>.zip among the artifacts");
  const manifest = {
    format: FORMAT,
    version: 1,
    release,
    minimumVersion: minimum,
    publishedAt: now.toISOString(),
    baseUrl: base,
    artifacts,
    ...(Object.keys(images).length ? { images } : {}),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function signManifest(bytes, privatePem) {
  const key = createPrivateKey(privatePem);
  return `${JSON.stringify({
    alg: "ed25519",
    keyId: keyIdOf(rawPublicKey(key)),
    signature: sign(null, bytes, key).toString("base64"),
  })}\n`;
}

export function verifyManifest(bytes, sigText, publicKeyB64) {
  const env = JSON.parse(sigText);
  const raw = Buffer.from(publicKeyB64, "base64");
  if (env.alg !== "ed25519" || env.keyId !== keyIdOf(raw)) return false;
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
  return verify(null, bytes, key, Buffer.from(env.signature, "base64"));
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "keygen") {
    const out = rest[0];
    if (!out) throw new Error("usage: keygen <private-key.pem>");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
      flag: "wx",
    });
    const raw = rawPublicKey(publicKey);
    process.stdout.write(
      `${JSON.stringify({ keyId: keyIdOf(raw), publicKey: raw.toString("base64") })}\n`,
    );
    return;
  }
  if (cmd === "build") {
    const opts = { files: [], images: {} };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--release") opts.release = rest[++i];
      else if (a === "--minimum") opts.minimum = rest[++i];
      else if (a === "--base") opts.base = rest[++i];
      else if (a === "--image") {
        const [k, v] = String(rest[++i]).split("=");
        opts.images[k] = v;
      } else opts.files.push(a);
    }
    process.stdout.write(buildManifest(opts));
    return;
  }
  if (cmd === "sign") {
    const file = rest[0];
    const pem = process.env.PSYCHE_RELEASE_SIGNING_KEY;
    if (!file || !pem)
      throw new Error("usage: PSYCHE_RELEASE_SIGNING_KEY=<pem> sign <update-manifest.json>");
    writeFileSync(`${file}.sig`, signManifest(readFileSync(file), pem));
    return;
  }
  if (cmd === "verify") {
    const [file, pub] = rest;
    const ok = verifyManifest(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), pub);
    process.stdout.write(ok ? "ok\n" : "BAD SIGNATURE\n");
    process.exit(ok ? 0 : 1);
  }
  throw new Error("commands: keygen, build, sign, verify");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`update-manifest: ${err.message}\n`);
    process.exit(2);
  }
}
