import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
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
  MANIFEST_FILE,
  type ManifestArtifact,
  ManifestError,
  planUpdate,
  type ReleaseKey,
  SIGNATURE_FILE,
  verifyManifest,
} from "./update-manifest.ts";

/**
 * The update check without Electron (security §11): fetch the signed manifest from the pinned
 * release host, verify it, download the zip it names while hashing it, and only then offer the
 * verified file to Squirrel.Mac through a loopback JSON feed. Squirrel then checks the code
 * signature as well; it never sees a file the manifest did not vouch for.
 */

/** Releases come only from here (security §11 "fetches only from the pinned release host"). */
export const PINNED_RELEASE_BASE = "https://github.com/devmello/psyche/releases/download/";
export const DEFAULT_FEED = "https://github.com/devmello/psyche/releases/latest/download/";

export interface UpdateCheckDeps {
  fetch: typeof fetch;
  currentVersion: string;
  arch: string;
  keys: readonly ReleaseKey[];
  /** Where `update-manifest.json` and its `.sig` are fetched; must be on github.com/devmello/psyche/releases. */
  feed?: string;
  pinnedBase?: string;
  /** Directory for the downloaded zip (0700). */
  dir: string;
  log(message: string): void;
}

export type UpdateCheck =
  | { state: "no_keys" }
  | { state: "none"; reason: string }
  | { state: "ready"; release: string; file: string; mandatory: boolean }
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
    });
    if (plan.action === "none") return { state: "none", reason: plan.reason };
    mkdirSync(d.dir, { recursive: true, mode: 0o700 });
    const file = join(d.dir, plan.artifact.name);
    await downloadVerified(d.fetch, plan.url, plan.artifact, file);
    d.log(
      `verified ${plan.artifact.name} for ${plan.release}${plan.mandatory ? " (required update)" : ""}`,
    );
    return { state: "ready", release: plan.release, file, mandatory: plan.mandatory };
  } catch (err) {
    if (err instanceof ManifestError)
      return { state: "refused", code: err.code, reason: err.message };
    throw err;
  }
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
}

export function writeUpdaterState(file: string, state: Omit<UpdaterStateFile, "version">): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
