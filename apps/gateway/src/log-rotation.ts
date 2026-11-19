import {
  closeSync,
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
 * (the live one included). Synchronous and small: a log line is a few hundred bytes. A write that
 * cannot reach the file goes to stderr instead, so logging never throws into the Gateway.
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
    size = statSync(path).size;
  };

  const rotate = (): void => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    const keep = files - 1;
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? path : `${path}.${i - 1}`;
      const to = `${path}.${i}`;
      try {
        if (i === keep) unlinkSync(to);
      } catch {
        // Nothing to drop yet.
      }
      try {
        renameSync(from, to);
      } catch {
        // Not there yet (first rotation, or a file that was removed by hand).
      }
    }
    open();
  };

  return (line) => {
    const bytes = Buffer.byteLength(`${line}\n`);
    try {
      if (fd === undefined) open();
      if (size > 0 && size + bytes > maxBytes) rotate();
      writeSync(fd as number, `${line}\n`);
      size += bytes;
    } catch {
      process.stderr.write(`${line}\n`);
    }
  };
}
