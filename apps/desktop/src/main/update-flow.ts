import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type InstallKind,
  MANIFEST_FILE,
  type ManifestArtifact,
  ManifestError,
  planUpdate,
  type ReleaseKey,
  SIGNATURE_FILE,
  type UpdatePlatform,
  verifyManifest,
} from "./update-manifest.ts";

/**
 * The update check without Electron (security §11): fetch the signed manifest from the pinned
 * release host, verify it, download the files it names while hashing them, and only then offer
 * the verified files to Squirrel. Squirrel never sees a file the manifest did not vouch for:
 *
 * - macOS: the zip, through a loopback JSON feed (Squirrel.Mac then checks the code signature);
 * - Windows: a local feed folder with Squirrel.Windows' RELEASES and the nupkg it names. RELEASES
 *   is checked against the verified nupkg (its SHA-1 and size, which Update.exe checks again) and
 *   cut down to the lines of the packages in the folder, so Update.exe reads nothing else;
 * - Linux: the AppImage, deb or rpm matching how this copy was installed, verified and left in a
 *   0700 directory for the apply step (src/packaging/linux-apply.ts).
 */

/** Releases come only from here (security §11 "fetches only from the pinned release host"). */
export const PINNED_RELEASE_BASE = "https://github.com/devmello/psyche/releases/download/";
export const DEFAULT_FEED = "https://github.com/devmello/psyche/releases/latest/download/";

export interface UpdateCheckDeps {
  fetch: typeof fetch;
  currentVersion: string;
  arch: string;
  /** Defaults to darwin. */
  platform?: UpdatePlatform;
  /** Linux: AppImage, deb or rpm, from how this copy runs (src/packaging/linux-install.ts). */
  installKind?: InstallKind;
  keys: readonly ReleaseKey[];
  /** Where `update-manifest.json` and its `.sig` are fetched; must be on github.com/devmello/psyche/releases. */
  feed?: string;
  pinnedBase?: string;
  /** Directory for the downloaded zip (0700). */
  dir: string;
  log(message: string): void;
  /** Looks at the downloaded zip before it is kept (update-gate.ts `inspectQuarantine`). */
  inspectDownload?(file: string): Promise<"absent" | "removed" | "unknown">;
}

export type UpdateCheck =
  | { state: "no_keys" }
  | { state: "none"; reason: string }
  | {
      state: "ready";
      release: string;
      /** The verified zip (macOS), nupkg (Windows) or AppImage/deb/rpm (Linux). */
      file: string;
      /** Linux: the manifest entry the file was verified against (its kind tells the apply step what to do). */
      artifact?: ManifestArtifact;
      mandatory: boolean;
      /** macOS: whether the download carried the quarantine flag (it should not: it is stripped if so). */
      quarantine?: "absent" | "removed" | "unknown";
      /** Windows: the folder to hand to Squirrel.Windows (RELEASES + nupkg). */
      feedDir?: string;
      /** Windows, when `file` is a delta: the full package, for switchToFullPackage if the delta fails. */
      full?: { artifact: ManifestArtifact; url: string };
    }
  | { state: "refused"; code: string; reason: string };

async function getBytes(f: typeof fetch, url: string): Promise<Uint8Array | null> {
  const res = await f(url, { redirect: "follow" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function downloadVerified(
  f: typeof fetch,
  url: string,
  artifact: ManifestArtifact,
  file: string,
): Promise<void> {
  const res = await f(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > artifact.bytes) {
        done(
          new ManifestError("hash_mismatch", `${artifact.name} is larger than the manifest says`),
        );
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as never),
    tap,
    createWriteStream(file, { mode: 0o600 }),
  );
  if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) {
    rmSync(file, { force: true });
    throw new ManifestError(
      "hash_mismatch",
      `${artifact.name}: the download does not match the manifest`,
    );
  }
}

export async function checkForVerifiedUpdate(d: UpdateCheckDeps): Promise<UpdateCheck> {
  if (d.keys.length === 0) return { state: "no_keys" };
  const pinned = d.pinnedBase ?? PINNED_RELEASE_BASE;
  const feed = d.feed ?? DEFAULT_FEED;
  const repoReleases = pinned.replace(/download\/$/, "");
  if (!feed.startsWith(repoReleases) || !feed.endsWith("/")) {
    return {
      state: "refused",
      code: "untrusted_host",
      reason: `feed ${feed} is not under ${repoReleases}`,
    };
  }
  try {
    const manifestBytes = await getBytes(d.fetch, new URL(MANIFEST_FILE, feed).toString());
    if (!manifestBytes)
      return { state: "none", reason: "the latest release has no update manifest" };
    const sig = await getBytes(d.fetch, new URL(SIGNATURE_FILE, feed).toString());
    const manifest = verifyManifest(
      manifestBytes,
      sig ? Buffer.from(sig).toString("utf8") : null,
      d.keys,
    );
    const plan = planUpdate(manifest, {
      currentVersion: d.currentVersion,
      arch: d.arch,
      pinnedBase: pinned,
      platform: d.platform ?? "darwin",
      ...(d.installKind ? { installKind: d.installKind } : {}),
    });
    if (plan.action === "none") return { state: "none", reason: plan.reason };
    mkdirSync(d.dir, { recursive: true, mode: 0o700 });
    if ((d.platform ?? "darwin") === "darwin") {
      const file = join(d.dir, plan.artifact.name);
      await downloadVerified(d.fetch, plan.url, plan.artifact, file);
      d.log(
        `verified ${plan.artifact.name} for ${plan.release}${plan.mandatory ? " (required update)" : ""}`,
      );
      const quarantine = d.inspectDownload ? await d.inspectDownload(file) : undefined;
      if (quarantine === "removed") {
        d.log(
          "the download carried com.apple.quarantine; removed it (the file matches the signed manifest)",
        );
      }
      return {
        state: "ready",
        release: plan.release,
        file,
        mandatory: plan.mandatory,
        ...(quarantine ? { quarantine } : {}),
      };
    }
    if (d.platform === "linux") {
      chmodSync(d.dir, 0o700);
      const file = join(d.dir, plan.artifact.name);
      await downloadVerified(d.fetch, plan.url, plan.artifact, file);
      d.log(
        `verified ${plan.artifact.name} for ${plan.release}${plan.mandatory ? " (required update)" : ""}`,
      );
      return {
        state: "ready",
        release: plan.release,
        file,
        artifact: plan.artifact,
        mandatory: plan.mandatory,
      };
    }
    // Windows: a fresh feed folder per release, then RELEASES, then the package.
    const feedDir = join(d.dir, `feed-${plan.release}`);
    rmSync(feedDir, { recursive: true, force: true });
    mkdirSync(feedDir, { recursive: true, mode: 0o700 });
    const fetched: string[] = [];
    try {
      for (const { artifact, url } of plan.files) {
        const file = join(feedDir, artifact.name);
        await downloadVerified(d.fetch, url, artifact, file);
        fetched.push(file);
      }
      const releasesFile = fetched[0] as string;
      const file = fetched[1] as string;
      const keep = [plan.artifact.name, ...(plan.full ? [plan.full.artifact.name] : [])];
      writeFileSync(
        releasesFile,
        squirrelReleasesFor(readFileSync(releasesFile, "utf8"), keep, [file]),
        { mode: 0o600 },
      );
      d.log(
        `verified ${plan.artifact.name} for ${plan.release}${plan.mandatory ? " (required update)" : ""}`,
      );
      return {
        state: "ready",
        release: plan.release,
        file,
        mandatory: plan.mandatory,
        feedDir,
        ...(plan.full ? { full: plan.full } : {}),
      };
    } catch (err) {
      rmSync(feedDir, { recursive: true, force: true });
      throw err;
    }
  } catch (err) {
    if (err instanceof ManifestError)
      return { state: "refused", code: err.code, reason: err.message };
    throw err;
  }
}

/** One line of Squirrel.Windows' RELEASES: `<SHA1> <file name> <size>`. */
export interface ReleasesEntry {
  sha1: string;
  name: string;
  bytes: number;
}

export function parseSquirrelReleases(text: string): ReleasesEntry[] {
  const out: ReleasesEntry[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9A-Fa-f]{40})\s+(\S+)\s+(\d+)$/.exec(line);
    if (!m) throw new ManifestError("malformed", "RELEASES has a malformed line");
    out.push({ sha1: (m[1] as string).toUpperCase(), name: m[2] as string, bytes: Number(m[3]) });
  }
  return out;
}

/**
 * RELEASES cut down to the packages in `keep` (in that order), after checking each file in
 * `present` against its line: Update.exe checks SHA-1 and size too, so a mismatch here means the
 * RELEASES file and the manifest disagree. A kept package without a line is refused.
 */
export function squirrelReleasesFor(
  text: string,
  keep: readonly string[],
  present: readonly string[],
): string {
  const entries = parseSquirrelReleases(text);
  const lines: string[] = [];
  for (const name of keep) {
    const e = entries.find((x) => x.name === name);
    if (!e) throw new ManifestError("hash_mismatch", `RELEASES does not list ${name}`);
    lines.push(`${e.sha1} ${e.name} ${e.bytes}`);
  }
  for (const file of present) {
    const name = file.split(/[\\/]/).pop() as string;
    const e = entries.find((x) => x.name === name);
    const bytes = readFileSync(file);
    const sha1 = createHash("sha1").update(bytes).digest("hex").toUpperCase();
    if (!e || e.bytes !== bytes.byteLength || e.sha1 !== sha1)
      throw new ManifestError("hash_mismatch", `${name} does not match its RELEASES line`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Windows, after a delta package failed to apply: downloads the full package (verified like the
 * rest) into the same feed folder and leaves RELEASES with its line only. Returns the feed folder.
 */
export async function switchToFullPackage(
  d: Pick<UpdateCheckDeps, "fetch" | "log">,
  ready: { feedDir: string; full: { artifact: ManifestArtifact; url: string } },
): Promise<string> {
  const file = join(ready.feedDir, ready.full.artifact.name);
  await downloadVerified(d.fetch, ready.full.url, ready.full.artifact, file);
  const releasesFile = join(ready.feedDir, "RELEASES");
  const text = readFileSync(releasesFile, "utf8");
  writeFileSync(releasesFile, squirrelReleasesFor(text, [ready.full.artifact.name], [file]), {
    mode: 0o600,
  });
  d.log(`verified ${ready.full.artifact.name}; retrying with the full package`);
  return ready.feedDir;
}

/**
 * A loopback feed in Squirrel.Mac's JSON format that offers exactly one verified file. Paths
 * carry a random token, so nothing else on the machine can guess them.
 */
export async function serveVerifiedUpdate(
  file: string,
  release: string,
): Promise<{ feedUrl: string; close(): Promise<void> }> {
  const token = randomBytes(16).toString("hex");
  const size = statSync(file).size;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`;
    if (req.url === `/${token}/feed`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: `${base}/update.zip`, name: release }));
      return;
    }
    if (req.url === `/${token}/update.zip`) {
      res.writeHead(200, { "content-type": "application/zip", "content-length": size });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    feedUrl: `http://127.0.0.1:${port}/${token}/feed`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * What the last update check found, for `psyche security audit` (it reads
 * `$PSYCHE_HOME/run/updater.json`; no network call). Never holds a URL with credentials, a key
 * or a file path outside $PSYCHE_HOME.
 */
export interface UpdaterStateFile {
  version: 1;
  state: "disabled" | "no_keys" | "none" | "refused" | "started";
  appVersion: string;
  /** Embedded release keys (0 = updates off). */
  keys: number;
  checkedAt: string;
  code?: string;
  reason?: string;
  release?: string;
  /** Whether the downloaded zip carried the quarantine flag: "absent" is the expected answer. */
  quarantine?: "absent" | "removed" | "unknown";
}

export function writeUpdaterState(file: string, state: Omit<UpdaterStateFile, "version">): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
