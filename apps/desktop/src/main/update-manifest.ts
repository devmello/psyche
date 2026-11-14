import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * Signed update manifests (feature A6; security §11). Pure: no Electron, no network.
 *
 * The release workflow publishes `update-manifest.json` and `update-manifest.json.sig` with every
 * release (deploy/scripts/update-manifest.mjs). Before anything is downloaded into place the
 * desktop checks, in order:
 *
 * 1. the signature: Ed25519 over the exact manifest bytes, by a key embedded in the app
 *    (release-keys.ts). Unsigned, unknown-key and mismatched manifests are refused;
 * 2. the manifest's shape and format version;
 * 3. the plan: never a downgrade or the same version, artifacts only under the pinned release
 *    base URL, the update artifacts for this platform and architecture;
 * 4. the downloaded artifact's SHA-256 and size against the manifest.
 *
 * Platforms. `artifacts` is the original list and holds macOS files only: Psyche builds before
 * Windows support check every entry of it and refuse a manifest with anything else there, so it
 * stays as it was. `platforms` (optional) maps `<platform>-<arch>` (`darwin-arm64`,
 * `darwin-x64`, `win32-x64`, `linux-x64`, `linux-arm64`) to that platform's files; older builds ignore it. A Mac reads
 * `platforms` when present and falls back to `artifacts`. Windows updates come only from
 * `platforms["win32-x64"]`: Squirrel's `RELEASES` list plus the full nupkg (and a delta nupkg
 * when it applies to the installed version). Keys and kinds this build does not know are skipped,
 * so a later platform or artifact kind does not make it refuse the manifest.
 *
 * Linux updates come only from `platforms["linux-<arch>"]`: an AppImage, a deb and an rpm. A copy
 * takes the entry whose kind is how it was installed (`InstallKind`), so an AppImage never
 * receives a deb and the reverse; an unknown install kind (a tarball, a dev build) gets none.
 */

export const MANIFEST_FORMAT = "psyche-update-manifest";
export const MANIFEST_FILE = "update-manifest.json";
export const SIGNATURE_FILE = "update-manifest.json.sig";

export interface ReleaseKey {
  /** First 16 hex chars of sha256(raw public key). */
  keyId: string;
  /** base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
}

export type UpdatePlatform = "darwin" | "win32" | "linux";

/** How this copy of the app got onto a Linux machine; decides the artifact it updates to. */
export type InstallKind = "appimage" | "deb" | "rpm";

/**
 * zip / dmg: macOS (and the portable Windows zip). squirrel-releases: Squirrel.Windows' RELEASES
 * list. nupkg-full / nupkg-delta: the packages it names; a delta applies only to `baseVersion`.
 * setup: the Windows installer (first installs, never an update). appimage / deb / rpm: Linux.
 */
export type ArtifactKind =
  | "zip"
  | "dmg"
  | "squirrel-releases"
  | "nupkg-full"
  | "nupkg-delta"
  | "setup"
  | "appimage"
  | "deb"
  | "rpm";

export interface ManifestArtifact {
  name: string;
  platform: UpdatePlatform;
  arch: "arm64" | "x64";
  kind: ArtifactKind;
  sha256: string;
  bytes: number;
  /** nupkg-delta: the release it applies to. */
  baseVersion?: string;
}

/** A `platforms` entry: the artifact without the platform and arch its key already says. */
export type PlatformArtifact = Omit<ManifestArtifact, "platform" | "arch">;

export const PLATFORM_KINDS: Record<UpdatePlatform, readonly ArtifactKind[]> = {
  darwin: ["zip", "dmg"],
  win32: ["squirrel-releases", "nupkg-full", "nupkg-delta", "setup", "zip"],
  linux: ["appimage", "deb", "rpm"],
};

export interface UpdateManifest {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  release: string;
  /** Installed versions below this must update before they keep running (security fixes). */
  minimumVersion: string;
  publishedAt: string;
  /** Every artifact is fetched from `baseUrl + name`. */
  baseUrl: string;
  /** macOS only (see above). */
  artifacts: ManifestArtifact[];
  /** `<platform>-<arch>` → files. Optional; only known keys and kinds are kept after parsing. */
  platforms?: Record<string, PlatformArtifact[]>;
  images?: Record<string, string>;
}

export interface SignatureEnvelope {
  alg: "ed25519";
  keyId: string;
  /** base64 Ed25519 signature over the manifest file's bytes. */
  signature: string;
}

export type ManifestErrorCode =
  | "unsigned"
  | "unknown_key"
  | "bad_signature"
  | "malformed"
  | "untrusted_host"
  | "no_artifact"
  | "hash_mismatch";

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

export function keyIdOf(rawPublicKey: Uint8Array): string {
  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

function publicKeyObject(key: ReleaseKey) {
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(key.publicKey, "base64").toString("base64url"),
    },
    format: "jwk",
  });
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** semver precedence: -1, 0, 1. Throws on a malformed version. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new ManifestError("malformed", `not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1; // a release ranks above its prereleases
  if (rb === undefined) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt && Number(s) !== Number(t)) return Math.sign(Number(s) - Number(t));
    if (ns !== nt) return ns ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseManifest(bytes: Uint8Array): UpdateManifest {
  let m: unknown;
  try {
    m = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ManifestError("malformed", "manifest is not JSON");
  }
  const bad = (why: string) => new ManifestError("malformed", `manifest ${why}`);
  if (!isObject(m) || m.format !== MANIFEST_FORMAT || m.version !== 1)
    throw bad("has an unknown format");
  for (const k of ["release", "minimumVersion", "publishedAt", "baseUrl"] as const) {
    if (typeof m[k] !== "string") throw bad(`lacks ${k}`);
  }
  compareVersions(m.release as string, m.minimumVersion as string);
  if (!Array.isArray(m.artifacts)) throw bad("lacks artifacts");
  if (m.platforms !== undefined) m.platforms = parsePlatforms(m.platforms, bad);
  for (const a of m.artifacts as unknown[]) {
    if (
      !isObject(a) ||
      typeof a.name !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(a.name) ||
      a.platform !== "darwin" ||
      (a.arch !== "arm64" && a.arch !== "x64") ||
      (a.kind !== "zip" && a.kind !== "dmg") ||
      typeof a.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(a.sha256) ||
      !Number.isInteger(a.bytes) ||
      (a.bytes as number) < 0
    ) {
      throw bad("has an invalid artifact");
    }
  }
  return m as unknown as UpdateManifest;
}

const PLATFORM_KEY = /^(darwin|win32|linux)-(arm64|x64)$/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * `platforms`: every entry under a known key must be well formed (a bad one is refused like a bad
 * `artifacts` entry); unknown keys and unknown kinds are dropped, not refused.
 */
function parsePlatforms(
  v: unknown,
  bad: (why: string) => ManifestError,
): Record<string, PlatformArtifact[]> {
  if (!isObject(v)) throw bad("has invalid platforms");
  const out: Record<string, PlatformArtifact[]> = {};
  for (const [key, list] of Object.entries(v)) {
    const k = PLATFORM_KEY.exec(key);
    if (!k) continue;
    const kinds = PLATFORM_KINDS[k[1] as UpdatePlatform];
    if (!Array.isArray(list)) throw bad(`has invalid platforms.${key}`);
    out[key] = [];
    for (const a of list as unknown[]) {
      if (
        !isObject(a) ||
        typeof a.name !== "string" ||
        !SAFE_NAME.test(a.name) ||
        typeof a.kind !== "string" ||
        typeof a.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(a.sha256) ||
        !Number.isInteger(a.bytes) ||
        (a.bytes as number) < 0 ||
        (a.baseVersion !== undefined && typeof a.baseVersion !== "string")
      ) {
        throw bad(`has an invalid artifact in platforms.${key}`);
      }
      if (typeof a.baseVersion === "string") compareVersions(a.baseVersion, a.baseVersion);
      if (!kinds.includes(a.kind as ArtifactKind)) continue;
      out[key].push({
        name: a.name,
        kind: a.kind as ArtifactKind,
        sha256: a.sha256,
        bytes: a.bytes as number,
        ...(typeof a.baseVersion === "string" ? { baseVersion: a.baseVersion } : {}),
      });
    }
  }
  return out;
}

/** This platform's artifacts: `platforms[<platform>-<arch>]`, else (macOS) the legacy list. */
export function artifactsFor(
  m: UpdateManifest,
  platform: UpdatePlatform,
  arch: string,
): ManifestArtifact[] {
  const listed = m.platforms?.[`${platform}-${arch}`];
  if (listed)
    return listed.map((a) => ({ ...a, platform, arch: arch as ManifestArtifact["arch"] }));
  if (platform !== "darwin") return [];
  return m.artifacts.filter((a) => a.platform === "darwin" && a.arch === arch);
}

/** Checks the signature with the embedded keys, then the manifest's shape. */
export function verifyManifest(
  bytes: Uint8Array,
  signatureText: string | null | undefined,
  trusted: readonly ReleaseKey[],
): UpdateManifest {
  if (!signatureText) throw new ManifestError("unsigned", "the manifest has no signature");
  let env: unknown;
  try {
    env = JSON.parse(signatureText);
  } catch {
    throw new ManifestError("unsigned", "the signature file is not JSON");
  }
  if (
    !isObject(env) ||
    env.alg !== "ed25519" ||
    typeof env.keyId !== "string" ||
    typeof env.signature !== "string"
  ) {
    throw new ManifestError("unsigned", "the signature file is not an ed25519 envelope");
  }
  const key = trusted.find((k) => k.keyId === env.keyId);
  if (!key)
    throw new ManifestError("unknown_key", `manifest signed by unknown key ${String(env.keyId)}`);
  let ok = false;
  try {
    ok = verify(null, bytes, publicKeyObject(key), Buffer.from(env.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new ManifestError("bad_signature", "manifest signature does not match");
  return parseManifest(bytes);
}

export interface UpdatePlanInput {
  currentVersion: string;
  arch: string;
  /** Defaults to darwin (the only platform before Windows support). */
  platform?: UpdatePlatform;
  /** Linux only: the packaging this copy runs from. Without it a Linux copy has no update. */
  installKind?: InstallKind;
  /** e.g. https://github.com/devmello/psyche/releases/download/ */
  pinnedBase: string;
}

export type UpdatePlan =
  | { action: "none"; reason: string }
  | {
      action: "update";
      release: string;
      /** The main file: the zip on macOS, the full or delta nupkg on Windows, the AppImage/deb/rpm on Linux. */
      artifact: ManifestArtifact;
      url: string;
      mandatory: boolean;
      /** Everything to download, verified, in order (macOS: the zip; Windows: RELEASES + nupkg). */
      files: { artifact: ManifestArtifact; url: string }[];
      /** Windows: the full nupkg, when `artifact` is a delta (the fallback if the delta fails). */
      full?: { artifact: ManifestArtifact; url: string };
    };

export function planUpdate(m: UpdateManifest, input: UpdatePlanInput): UpdatePlan {
  if (!m.baseUrl.startsWith(input.pinnedBase) || !m.baseUrl.endsWith("/")) {
    throw new ManifestError("untrusted_host", `artifacts are not under ${input.pinnedBase}`);
  }
  const base = new URL(m.baseUrl);
  if (base.protocol !== "https:")
    throw new ManifestError("untrusted_host", "artifacts must be served over https");
  if (compareVersions(m.release, input.currentVersion) <= 0) {
    return { action: "none", reason: `${m.release} is not newer than ${input.currentVersion}` };
  }
  const platform = input.platform ?? "darwin";
  const list = artifactsFor(m, platform, input.arch);
  const at = (artifact: ManifestArtifact) => ({
    artifact,
    url: new URL(artifact.name, base).toString(),
  });
  const mandatory = compareVersions(input.currentVersion, m.minimumVersion) < 0;
  const none = () =>
    new ManifestError("no_artifact", `no update for ${platform}-${input.arch} in ${m.release}`);
  if (platform === "darwin") {
    const artifact = list.find((a) => a.kind === "zip");
    if (!artifact) throw none();
    const file = at(artifact);
    return { action: "update", release: m.release, ...file, mandatory, files: [file] };
  }
  if (platform === "linux") {
    // The artifact whose kind is the install kind; nothing else is ever offered.
    const artifact = input.installKind ? list.find((a) => a.kind === input.installKind) : undefined;
    if (!artifact) {
      throw new ManifestError(
        "no_artifact",
        `no update for linux-${input.arch}-${input.installKind ?? "unknown"} in ${m.release}`,
      );
    }
    const file = at(artifact);
    return { action: "update", release: m.release, ...file, mandatory, files: [file] };
  }
  // Windows: Squirrel reads RELEASES, then the package it names. A delta is only for the version
  // it was made from; anything else takes the full package.
  const releases = list.find((a) => a.kind === "squirrel-releases");
  const full = list.find((a) => a.kind === "nupkg-full");
  if (!releases || !full) throw none();
  const delta = list.find(
    (a) =>
      a.kind === "nupkg-delta" &&
      a.baseVersion !== undefined &&
      compareVersions(a.baseVersion, input.currentVersion) === 0,
  );
  const main = at(delta ?? full);
  return {
    action: "update",
    release: m.release,
    ...main,
    mandatory,
    files: [at(releases), main],
    ...(delta ? { full: at(full) } : {}),
  };
}

/** The downloaded artifact must be byte-for-byte the one the manifest names. */
export function verifyArtifact(bytes: Uint8Array, artifact: ManifestArtifact): void {
  if (bytes.byteLength !== artifact.bytes) {
    throw new ManifestError(
      "hash_mismatch",
      `${artifact.name}: ${bytes.byteLength} bytes, manifest says ${artifact.bytes}`,
    );
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== artifact.sha256)
    throw new ManifestError(
      "hash_mismatch",
      `${artifact.name}: SHA-256 does not match the manifest`,
    );
}
