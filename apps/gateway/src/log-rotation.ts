import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * A line sink that appends to `path` and rotates it in-process once it would pass `maxBytes`:
 * `path` becomes `path.1`, `path.1` becomes `path.2`, and so on, keeping `files` files in all
 * (the live one included).
 *
 * Safety:
 * - A line that cannot reach the file (no directory, no permission, disk full) goes to stderr, and
 *   the Gateway never throws because of logging.
 * - Each write follows the path, not the open descriptor: if another sink or process rotated the
 *   file since the last write, the sink reopens the current file first, so no line goes to a file
 *   that was already rotated away.
 * - A rotation that fails part-way (another rotation renamed the same files) is not fatal: the
 *   line is still written to the current file.
 */
export interface RotatingSinkOptions {
  maxBytes?: number;
  files?: number;
}

export function rotatingFileSink(
  path: string,
  opts: RotatingSinkOptions = {},
): (line: string) => void {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const files = Math.max(1, opts.files ?? 3);
  let fd: number | undefined;
  let size = 0;

  const open = (): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(path, "a", 0o600);
    size = fstatSync(fd).size;
  };

  /** Drops the descriptor when the path no longer names the file it points at. */
  const follow = (): void => {
    if (fd === undefined) return;
    let same = false;
    try {
      same = fstatSync(fd).ino === statSync(path).ino;
    } catch {
      same = false;
    }
    if (!same) {
      closeSync(fd);
      fd = undefined;
    }
  };

  const rotate = (): void => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    const keep = files - 1;
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? path : `${path}.${i - 1}`;
      const to = `${path}.${i}`;
      if (i === keep) {
        try {
          unlinkSync(to);
        } catch {
          // Nothing to drop yet.
        }
      }
      try {
        renameSync(from, to);
      } catch {
        // Not there (first rotation, a racing rotation, or removed by hand).
      }
    }
  };

  return (line) => {
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    try {
      follow();
      if (fd === undefined) open();
      if (size > 0 && size + bytes > maxBytes) {
        try {
          rotate();
        } catch {
          // Keep writing where we are; the cap is best effort for this line.
        }
        if (fd === undefined) open();
      }
      writeSync(fd as number, text);
      size += bytes;
    } catch {
      process.stderr.write(text);
    }
  };
}
