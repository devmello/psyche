import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { PsycheError } from "@psyche/protocol";

/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

/**
 * The longest socket file name srt (or a server) creates in `TMPDIR`: `srt-mux-<pid>-<n>.sock`
 * is 27 bytes with a 10-digit pid; the rest is headroom for other names.
 */
export const SCRATCH_SOCKET_NAME_BYTES = 40;

export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path, "utf8") <= MAX_SOCKET_PATH_BYTES;
}

/**
 * Whether a scratch directory leaves room for a socket file in it. Windows has no `sun_path`
 * limit to fit (and srt, the only thing that makes sockets there, does not run on Windows), so the
 * first candidate, under the settings directory, is always used.
 */
export function scratchFits(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return true;
  return socketPathFits(join(dir, "x".repeat(SCRATCH_SOCKET_NAME_BYTES)));
}

function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Creates `dir` as a private directory, or refuses one that is a link or not ours. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  const uid = ownerUid();
  if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new PsycheError(
      "forbidden",
      `refusing scratch directory ${dir}: not a private directory`,
    );
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/**
 * A fresh private scratch directory (mode 0700) that a Unix socket can live in. srt creates its
 * `srt-mux-*.sock` files in the `TMPDIR` it is given, and `sun_path` is 104 bytes on macOS, so a
 * name built from the server id plus a UUID under a deep `$PSYCHE_HOME` overflowed it (EINVAL).
 *
 * The name is a short random token, never the server id. It lives in `settingsDir` when that
 * leaves room for a socket, else in a private per-user directory under the temp dir (then `/tmp`);
 * nothing else changes about the directory: the caller still allows writes to it alone.
 */
export async function createScratchDir(settingsDir: string): Promise<string> {
  const token = randomBytes(5).toString("hex");
  const uid = ownerUid() ?? 0;
  const candidates = [
    join(settingsDir, `s-${token}`),
    join(tmpdir(), `psyche-${uid}`, `s-${token}`),
    join("/tmp", `psyche-${uid}`, `s-${token}`),
  ];
  for (const dir of candidates) {
    if (!scratchFits(dir)) continue;
    await ensurePrivateDir(dirname(dir));
    await mkdir(dir, { mode: 0o700 });
    return dir;
  }
  throw new PsycheError(
    "invalid_params",
    `no scratch directory fits a Unix socket (${candidates[0]}); set TMPDIR to a shorter path`,
  );
}

/**
 * srt read rules that keep a scratch directory kept outside `$PSYCHE_HOME` as private as one
 * inside it: its parent (shared by every server's scratch) is denied, the one directory is
 * re-allowed (`allowRead` wins over `denyRead` in srt).
 */
export function scratchReadRules(
  psycheHome: string,
  scratchDir: string,
): { denyRead: string[]; allowRead: string[] } {
  const inside =
    scratchDir.startsWith(`${psycheHome}${sep}`) || scratchDir.startsWith(`${psycheHome}/`);
  return inside
    ? { denyRead: [], allowRead: [] }
    : { denyRead: [dirname(scratchDir)], allowRead: [scratchDir] };
}
