import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";

/**
 * Installing `srt` into Psyche's own tools folder with the Gateway's bundled Node (owner's
 * request: "use the psyche nodejs environment to set up srt, so it knows where it is").
 * The app ships `runtime/node` only, no npm, so this fetches the pinned package and its
 * dependencies straight from the npm registry with Node's fetch, checks each tarball against the
 * `dist.integrity` recorded below, and unpacks it. No lifecycle scripts run, nothing goes to a
 * global prefix, nothing needs sudo. Any mismatch fails closed and leaves nothing behind.
 *
 * Source of the pins: `npm view @anthropic-ai/sandbox-runtime@0.0.81 dist.integrity` and the
 * resolved flat dependency tree (`npm install --package-lock-only --ignore-scripts`), 2026-10-28.
 * Bump all of it together (and the test) when moving to a newer srt.
 */

export const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
export const SRT_VERSION = "0.0.81";
/** The package's bin entry (`"bin": {"srt": "dist/cli.js"}`). */
export const SRT_ENTRY = "dist/cli.js";
export const NPM_REGISTRY = "https://registry.npmjs.org/";
const MAX_TARBALL_BYTES = 40 * 1024 * 1024;

export interface SrtPin {
  name: string;
  version: string;
  /** npm's `dist.integrity` (`sha512-<base64>`). */
  integrity: string;
}

/** srt and its whole dependency tree (flat; none has an install script). */
export const SRT_PINS: readonly SrtPin[] = [
  {
    name: SRT_PACKAGE,
    version: SRT_VERSION,
    integrity:
      "sha512-bjHDu87gjIR7+Oxy9jPiK3v8CvSELCzfpXa3fjqfSKdvlZET2iF51xcXILWPayTpowB3xtZeQVf2JR916nVW/w==",
  },
  {
    name: "@pondwader/socks5-server",
    version: "1.0.10",
    integrity:
      "sha512-bQY06wzzR8D2+vVCUoBsr5QS2U6UgPUQRmErNwtsuI6vLcyRKkafjkr3KxbtGFf9aBBIV2mcvlsKD1UYaIV+sg==",
  },
  {
    name: "commander",
    version: "12.1.0",
    integrity:
      "sha512-Vw8qHK3bZM9y/P10u3Vib8o/DdkvA2OtPtZvD871QKjy74Wj1WSKFILMPRPSdUSx5RFK1arlJzEtA4PkFgnbuA==",
  },
  {
    name: "node-forge",
    version: "1.4.2",
    integrity:
      "sha512-rRtAR5XLJ8gCKd9du4qrKAsgCG1ObGP4gLeNJMa4vYSeq4bmBMOJk5IHkrviBV0q7uoAJlVd8HEQYQSVUb4FGQ==",
  },
  {
    name: "zod",
    version: "3.25.76",
    integrity:
      "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==",
  },
];

/** `https://registry.npmjs.org/@scope/name/-/name-1.2.3.tgz`: the only URLs fetched. */
export function tarballUrl(pin: SrtPin): string {
  return `${NPM_REGISTRY}${pin.name}/-/${pin.name.split("/").pop()}-${pin.version}.tgz`;
}

export type SrtInstallErrorCode =
  | "download_failed"
  | "integrity_mismatch"
  | "extract_failed"
  | "write_failed";

export class SrtInstallError extends Error {
  readonly code: SrtInstallErrorCode;
  constructor(code: SrtInstallErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SrtInstallError";
  }
}

export interface SrtInstallDeps {
  fetch: typeof fetch;
  /** Unpacks an npm tarball into `dest`, dropping the leading `package/` folder. */
  extract(tarball: Buffer, dest: string): Promise<void>;
}

/** Where a version goes: `<home>/tools/srt/<version>`. */
export function srtInstallDir(home: string, version: string = SRT_VERSION): string {
  return join(home, "tools", "srt", version);
}

/** The launcher inside an install dir (what `exec.srtPath` records). */
export function srtLauncherPath(dir: string): string {
  return join(dir, "bin", "srt");
}

/** The version of a Psyche-installed srt that `path` is the launcher of, else `null`. */
export function installedSrtVersion(home: string, path: unknown): string | null {
  if (typeof path !== "string") return null;
  const root = join(home, "tools", "srt") + sep;
  if (!path.startsWith(root)) return null;
  const [version, ...rest] = path.slice(root.length).split(sep);
  return version && rest.join(sep) === join("bin", "srt") ? version : null;
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** A /bin/sh launcher that runs Psyche's Node on srt's entry (no PATH, no env needed). */
export function launcherScript(nodePath: string, entry: string): string {
  return `#!/bin/sh\n# Written by Psyche's srt installer.\nexec ${shQuote(nodePath)} ${shQuote(entry)} "$@"\n`;
}

async function download(deps: SrtInstallDeps, pin: SrtPin): Promise<Buffer> {
  const url = tarballUrl(pin);
  let res: Response;
  try {
    res = await deps.fetch(url, { redirect: "error" });
  } catch (e) {
    throw new SrtInstallError(
      "download_failed",
      `Could not fetch ${pin.name}@${pin.version}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new SrtInstallError(
      "download_failed",
      `${pin.name}@${pin.version}: the registry answered ${res.status}`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_TARBALL_BYTES) {
    throw new SrtInstallError("download_failed", `${pin.name}@${pin.version} is too large`);
  }
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== pin.integrity) {
    throw new SrtInstallError(
      "integrity_mismatch",
      `${pin.name}@${pin.version} does not match its pinned integrity; nothing was installed`,
    );
  }
  return bytes;
}

export interface SrtInstallResult {
  version: string;
  dir: string;
  /** The launcher: what to save as `exec.srtPath`. */
  path: string;
  packages: { name: string; version: string; integrity: string; url: string }[];
}

/**
 * Downloads and verifies every pin first, then unpacks into a temporary folder beside the
 * target and renames it into place, so a failure leaves any earlier install untouched.
 */
export async function installSrt(
  deps: SrtInstallDeps,
  options: { home: string; nodePath: string; pins?: readonly SrtPin[] },
): Promise<SrtInstallResult> {
  const pins = options.pins ?? SRT_PINS;
  const root = pins[0];
  if (root === undefined) throw new SrtInstallError("download_failed", "No package to install");
  const tarballs: Buffer[] = [];
  for (const pin of pins) tarballs.push(await download(deps, pin));

  const parent = join(options.home, "tools", "srt");
  const dir = srtInstallDir(options.home, root.version);
  const tmp = join(parent, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(join(options.home, "tools"), 0o700);
    await chmod(parent, 0o700);
    await mkdir(tmp, { mode: 0o700 });
    for (const [i, pin] of pins.entries()) {
      const dest = join(tmp, "node_modules", ...pin.name.split("/"));
      await mkdir(dest, { recursive: true, mode: 0o700 });
      try {
        await deps.extract(tarballs[i] as Buffer, dest);
      } catch (e) {
        throw new SrtInstallError(
          "extract_failed",
          `Could not unpack ${pin.name}@${pin.version}: ${(e as Error).message}`,
        );
      }
    }
    const entry = join(dir, "node_modules", ...root.name.split("/"), SRT_ENTRY);
    await mkdir(join(tmp, "bin"), { mode: 0o700 });
    await writeFile(join(tmp, "bin", "srt"), launcherScript(options.nodePath, entry), {
      mode: 0o755,
    });
    await chmod(join(tmp, "bin", "srt"), 0o755);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    await chmod(dir, 0o700);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (e instanceof SrtInstallError) throw e;
    throw new SrtInstallError("write_failed", `Could not write ${dir}: ${(e as Error).message}`);
  }
  return {
    version: root.version,
    dir,
    path: srtLauncherPath(dir),
    packages: pins.map((p) => ({
      name: p.name,
      version: p.version,
      integrity: p.integrity,
      url: tarballUrl(p),
    })),
  };
}

function run(file: string, args: string[], input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString("utf8"))
        : reject(new Error(Buffer.concat(err).toString("utf8").trim() || `tar exited ${code}`)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Entries that could write outside `dest` or plant a link: anything but files and folders. */
export function unsafeTarEntry(line: string): boolean {
  const type = line[0];
  if (type !== "-" && type !== "d") return true;
  const name = line.split(/\s+/).slice(8).join(" ");
  return name.startsWith("/") || name.split("/").includes("..");
}

/** The system `tar` (macOS ships bsdtar), after a listing check; nothing else is executed. */
export const systemSrtInstallDeps: SrtInstallDeps = {
  fetch: (url, init) => fetch(url, init),
  async extract(tarball, dest) {
    const listing = await run("/usr/bin/tar", ["-tvzf", "-"], tarball);
    const bad = listing.split("\n").find((l) => l !== "" && unsafeTarEntry(l));
    if (bad !== undefined) throw new Error(`unsafe entry in tarball: ${basename(bad)}`);
    await run("/usr/bin/tar", ["-xzf", "-", "--strip-components=1", "-C", dest], tarball);
  },
};
