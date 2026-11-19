// Signed update manifests for the desktop updater (security §11; apps/desktop/src/main/update-manifest.ts).
//
//   node update-manifest.mjs keygen <private-key.pem>      new Ed25519 release key (0600); prints
//                                                            {keyId, publicKey} for release-keys.ts
//   node update-manifest.mjs build --release 1.2.3 --base <url>/ [--minimum 1.0.0]
//        [--image gateway=ghcr.io/…@sha256:…] [--win-arch x64] [--delta-base 1.2.2]
//        <artifacts…>                                      prints update-manifest.json
//        (macOS zips/DMGs, and the Windows RELEASES, nupkgs, Setup.exe and zip; --delta-base names
//        the release a delta nupkg was made from, without it clients use the full package)
//   node update-manifest.mjs sign <update-manifest.json>   writes <file>.sig with the key in
//                                                            PSYCHE_RELEASE_SIGNING_KEY (PEM)
//   node update-manifest.mjs verify <update-manifest.json> <publicKey-base64>
//   node update-manifest.mjs verify-trusted <update-manifest.json> <release-keys.ts>
//                                                          verifies against the key the .sig names,
//                                                            which must be one the app trusts
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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT = "psyche-update-manifest";
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Whether `classifyArtifact` knows the desktop Linux packages (`Psyche-<v>-linux-<arch>.deb|rpm|
 * AppImage`, L2). release.yml asks this script for the constant (it imports the module), so a
 * comment cannot flip the gate; set it to true together with that classification. The
 * helper-only and server packages below are not the desktop's.
 */
export const DESKTOP_LINUX_SUPPORT = false;

export function keyIdOf(raw) {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function rawPublicKey(keyObject) {
  const pub = keyObject.type === "public" ? keyObject : createPublicKey(keyObject);
  return Buffer.from(pub.export({ format: "jwk" }).x, "base64url");
}

/**
 * What a release file is, from its name. Windows files (deploy/windows/build-local.ps1 and the
 * Squirrel maker): `Psyche-<v>-Setup.exe`, `Psyche-<v>-win32-<arch>.zip`, Squirrel's `RELEASES`
 * and `Psyche-<nuget-version>-full.nupkg` / `-delta.nupkg` (those name no arch: `winArch`).
 * Anything else named `Psyche-<v>-[darwin-]<arch>.zip|dmg` is macOS.
 */
/** `{ platform, kind, arch }` for a release file name, or null when it is not one. */
export function classifyArtifact(name, winArch = "x64") {
  if (name === "RELEASES") return { platform: "win32", kind: "squirrel-releases", arch: winArch };
  const nupkg = /^Psyche-.+-(full|delta)\.nupkg$/.exec(name);
  if (nupkg) return { platform: "win32", kind: `nupkg-${nupkg[1]}`, arch: winArch };
  if (/^Psyche-.+-Setup\.exe$/.test(name))
    return { platform: "win32", kind: "setup", arch: winArch };
  const winZip = /^Psyche-.+-win32-(arm64|x64)\.zip$/.exec(name);
  if (winZip) return { platform: "win32", kind: "zip", arch: winZip[1] };
  // The Linux helper-only and server packages (docs/design/linux-helper-only-2026.md, section 9):
  // `psyche-helper-<v>-linux-<arch>.<tar.zst|deb|rpm>` and `psyche-server-<v>-linux-<arch>.<ext>`.
  // Desktop builds skip platform keys and kinds they do not know, so these are invisible to them.
  const linux = /^psyche-(helper|server)-.+-linux-(arm64|x64)\.(tar\.zst|deb|rpm)$/.exec(name);
  if (linux) {
    const ext = linux[3] === "tar.zst" ? "tar-zst" : linux[3];
    return { platform: "linux", kind: `${linux[1]}-${ext}`, arch: linux[2] };
  }
  const mac = /^Psyche-(.+?)-(?:darwin-)?(arm64|x64)\.(zip|dmg)$/.exec(name);
  if (mac) return { platform: "darwin", kind: mac[3], arch: mac[2] };
  return null;
}

export function artifactOf(path, { winArch = "x64", deltaBase } = {}) {
  const name = basename(path);
  const what = classifyArtifact(name, winArch);
  if (!what) return null;
  const { platform, kind, arch } = what;
  const bytes = readFileSync(path);
  return {
    name,
    platform,
    arch,
    kind,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: statSync(path).size,
    ...(kind === "nupkg-delta" && deltaBase ? { baseVersion: deltaBase } : {}),
  };
}

/**
 * The manifest. `artifacts` keeps only macOS files, exactly as before Windows support: released
 * Mac builds refuse a manifest with anything else there (apps/desktop/src/main/update-manifest.ts).
 * With Windows files, `platforms` lists every platform's files by `<platform>-<arch>`.
 */
export function buildManifest({
  release,
  minimum = "0.0.0",
  base,
  images = {},
  files,
  winArch,
  deltaBase,
  linuxOnly = false,
  noMac = false,
  now = new Date(),
}) {
  if (!VERSION.test(release) || !VERSION.test(minimum))
    throw new Error("versions must look like 1.2.3");
  if (deltaBase !== undefined && !VERSION.test(deltaBase))
    throw new Error("--delta-base must look like 1.2.3");
  if (!/^https:\/\/.+\/$/.test(base)) throw new Error("--base must be an https URL ending in /");
  // A file the caller named that this script cannot classify is an error, never a silent drop
  // (a desktop Linux package would otherwise ship with no manifest entry). The one exception is
  // an unexpanded shell glob (`artifacts/Psyche-*.dmg` with no match): it names no file.
  const all = [];
  for (const f of files) {
    if (/[*?[]/.test(f) && !existsSync(f)) continue;
    const a = artifactOf(f, { winArch, deltaBase });
    if (!a) throw new Error(`cannot classify ${basename(f)}: not a known release file`);
    all.push(a);
  }
  const mac = all.filter((a) => a.platform === "darwin");
  const win = all.filter((a) => a.platform === "win32");
  const linux = all.filter((a) => a.platform === "linux");
  const macUpdate = mac.some((a) => a.kind === "zip");
  const winUpdate =
    win.some((a) => a.kind === "squirrel-releases") && win.some((a) => a.kind === "nupkg-full");
  // Every Mac client reads the latest manifest, so one with no Mac update (a Windows-only or
  // Linux-only one) would make them all refuse it. Leaving the Mac out takes an explicit --no-mac,
  // or --linux-only for a Linux-only manifest. The release job passes neither.
  if (!macUpdate && !noMac && !(linuxOnly && linux.length > 0))
    throw new Error(
      "no Mac update among the artifacts: a Psyche-<version>-darwin-<arch>.zip is required (--no-mac, or --linux-only for a Linux-only manifest, allows leaving it out)",
    );
  if (!macUpdate && !winUpdate && linux.length === 0)
    throw new Error(
      "no update among the artifacts: a Psyche-<version>-darwin-<arch>.zip, or RELEASES and a Psyche-<version>-full.nupkg",
    );
  if (win.length && !winUpdate)
    throw new Error("Windows files without RELEASES and the full nupkg cannot update anyone");
  let platforms;
  if (win.length || linux.length) {
    platforms = {};
    for (const { platform, arch, ...rest } of all) {
      const key = `${platform}-${arch}`;
      platforms[key] = [...(platforms[key] ?? []), rest];
    }
  }
  const manifest = {
    format: FORMAT,
    version: 1,
    release,
    minimumVersion: minimum,
    publishedAt: now.toISOString(),
    baseUrl: base,
    artifacts: mac,
    ...(platforms ? { platforms } : {}),
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

/**
 * The keys the app trusts: `TRUSTED_RELEASE_KEYS` as the app itself evaluates it, by importing
 * release-keys.ts (Node strips its types). Parsing the source could disagree with what the app
 * runs (a key in a comment, a second list, a filter); importing cannot. Every entry must be a plain
 * { keyId, publicKey } whose keyId matches its key, or this throws. Only public keys live there.
 */
export async function loadTrustedKeys(keysFile) {
  const mod = await import(`${pathToFileURL(resolve(keysFile)).href}?t=${Date.now()}`);
  const list = mod.TRUSTED_RELEASE_KEYS;
  if (!Array.isArray(list))
    throw new Error("release-keys.ts: TRUSTED_RELEASE_KEYS is not an array");
  return list.map((k, i) => {
    const ok =
      k !== null &&
      typeof k === "object" &&
      Object.keys(k).sort().join(",") === "keyId,publicKey" &&
      /^[0-9a-f]{16}$/.test(k.keyId) &&
      /^[A-Za-z0-9+/]{43}=$/.test(k.publicKey) &&
      keyIdOf(Buffer.from(k.publicKey, "base64")) === k.keyId;
    if (!ok) throw new Error(`release-keys.ts: entry ${i} is not a valid { keyId, publicKey }`);
    return { keyId: k.keyId, publicKey: k.publicKey };
  });
}

/**
 * Verify against the key the signature names, but only if the app trusts that key (it is in
 * release-keys.ts). A secret that is a different key than the one shipped in the app still
 * self-verifies, and every client would then refuse the release.
 */
export function verifyTrusted(bytes, sigText, trusted) {
  let env;
  try {
    env = JSON.parse(sigText);
  } catch {
    return { ok: false, why: "the signature file is not JSON" };
  }
  if (trusted.length === 0) return { ok: false, why: "release-keys.ts holds no trusted key" };
  const key = trusted.find((k) => k.keyId === env.keyId);
  if (!key)
    return {
      ok: false,
      why: `signed by key ${env.keyId}, which is not in release-keys.ts (trusted: ${trusted.map((k) => k.keyId).join(", ")})`,
    };
  if (!verifyManifest(bytes, sigText, key.publicKey))
    return { ok: false, why: `the signature does not verify against trusted key ${key.keyId}` };
  return { ok: true, keyId: key.keyId };
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

async function main(argv) {
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
      else if (a === "--win-arch") opts.winArch = rest[++i];
      else if (a === "--delta-base") opts.deltaBase = rest[++i];
      else if (a === "--linux-only") opts.linuxOnly = true;
      else if (a === "--no-mac") opts.noMac = true;
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
  if (cmd === "verify-trusted") {
    const [file, keysFile] = rest;
    if (!file || !keysFile)
      throw new Error("usage: verify-trusted <update-manifest.json> <release-keys.ts>");
    const r = verifyTrusted(
      readFileSync(file),
      readFileSync(`${file}.sig`, "utf8"),
      await loadTrustedKeys(keysFile),
    );
    process.stdout.write(r.ok ? `ok (trusted key ${r.keyId})\n` : `UNTRUSTED: ${r.why}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  throw new Error("commands: keygen, build, sign, verify, verify-trusted");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`update-manifest: ${err.message}\n`);
    process.exit(2);
  });
}
