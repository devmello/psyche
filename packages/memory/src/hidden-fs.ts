import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Reads and writes of Psyche's own hidden files in the workspace (`.psyche/…`: the provenance
 * sidecars and the machine id). A git remote controls what a pull puts there, so it can turn any
 * of these into a symlink. Nothing here follows one: every component is checked with `lstat`,
 * reads open with `O_NOFOLLOW` and refuse anything but a regular file, and writes go to a fresh
 * `O_EXCL` temp file in the checked directory that is then renamed over the target (a rename
 * replaces a symlink, it never writes through it).
 */

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The real directory `root/parts…`, every component checked with `lstat`. With `create`, a missing
 * component is made, and a symlink or other non-directory in its place is unlinked (the link itself,
 * never its target) and replaced by a real directory. Without `create`, returns undefined when any
 * component is missing or is not a real directory.
 */
export function realDirUnder(
  root: string,
  parts: readonly string[],
  options: { create: boolean; mode: number },
): string | undefined {
  let dir = realpathSync(root);
  for (const part of parts) {
    dir = join(dir, part);
    const st = lstatOrUndefined(dir);
    if (st?.isDirectory()) continue;
    if (!options.create) return undefined;
    if (st !== undefined) unlinkSync(dir);
    mkdirSync(dir, { mode: options.mode });
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
    chmodSync(dir, options.mode);
  }
  return dir;
}

/**
 * Text of the regular file `dir/name`, or undefined when it is missing, a symlink, not a regular
 * file, or larger than `maxBytes`. `dir` must come from `realDirUnder`.
 */
export function readRegularFile(dir: string, name: string, maxBytes: number): string | undefined {
  const path = join(dir, name);
  const st = lstatOrUndefined(path);
  if (st === undefined || !st.isFile() || st.size > maxBytes) return undefined;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > maxBytes) return undefined;
    const buf = Buffer.alloc(fst.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, null);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `dir/name` atomically without following a link: the text goes to a new temp file (`O_EXCL`,
 * `O_NOFOLLOW`) in `dir`, which is renamed over the target. A real directory in the target's place
 * is removed first (a recursive remove never follows the links inside). `dir` must come from
 * `realDirUnder`.
 */
export function writeFileReplacing(dir: string, name: string, text: string, mode: number): void {
  const target = join(dir, name);
  if (lstatOrUndefined(target)?.isDirectory()) rmSync(target, { recursive: true, force: true });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, text);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}
