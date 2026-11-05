// Signed update manifests for the desktop updater (security §11; apps/desktop/src/main/update-manifest.ts).
//
//   node update-manifest.mjs keygen <private-key.pem>      new Ed25519 release key (0600); prints
//                                                            {keyId, publicKey} for release-keys.ts
//   node update-manifest.mjs build --release 1.2.3 --base <url>/ [--minimum 1.0.0]
//        [--image gateway=ghcr.io/…@sha256:…] [--win-arch x64] [--delta-base 1.2.2]
//        <artifacts…>                                      prints update-manifest.json
//        (macOS zips/DMGs, the Windows RELEASES, nupkgs, Setup.exe and zip, and the Linux
//        Psyche-<v>-linux-<arch>.AppImage|deb|rpm; --delta-base names the release a delta nupkg
//        was made from, without it clients use the full package)
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
import { pathToFileURL } from "node:url";

const FORMAT = "psyche-update-manifest";
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

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
 * Linux files (apps/desktop/forge.config.ts postMake): `Psyche-<v>-linux-<arch>.AppImage|deb|rpm`.
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
  const linux = /^Psyche-.+-linux-(arm64|x64)\.(AppImage|deb|rpm)$/.exec(name);
  if (linux) return { platform: "linux", kind: linux[2].toLowerCase(), arch: linux[1] };
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
 * With Windows or Linux files, `platforms` lists every platform's files by `<platform>-<arch>`.
 */
export function buildManifest({
  release,
  minimum = "0.0.0",
  base,
  images = {},
  files,
  winArch,
  deltaBase,
  now = new Date(),
}) {
  if (!VERSION.test(release) || !VERSION.test(minimum))
    throw new Error("versions must look like 1.2.3");
  if (deltaBase !== undefined && !VERSION.test(deltaBase))
    throw new Error("--delta-base must look like 1.2.3");
  if (!/^https:\/\/.+\/$/.test(base)) throw new Error("--base must be an https URL ending in /");
  const all = files.map((f) => artifactOf(f, { winArch, deltaBase })).filter(Boolean);
  const mac = all.filter((a) => a.platform === "darwin");
  const win = all.filter((a) => a.platform === "win32");
  const linux = all.filter((a) => a.platform === "linux");
  const macUpdate = mac.some((a) => a.kind === "zip");
  const winUpdate =
    win.some((a) => a.kind === "squirrel-releases") && win.some((a) => a.kind === "nupkg-full");
  if (!macUpdate && !winUpdate && !linux.length)
    throw new Error(
      "no update among the artifacts: a Psyche-<version>-darwin-<arch>.zip, RELEASES and a Psyche-<version>-full.nupkg, or a Psyche-<version>-linux-<arch>.AppImage|deb|rpm",
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
      else if (a === "--win-arch") opts.winArch = rest[++i];
      else if (a === "--delta-base") opts.deltaBase = rest[++i];
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`update-manifest: ${err.message}\n`);
    process.exit(2);
  }
}
