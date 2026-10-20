import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ErrorPayload } from "@psyche/protocol";
import {
  type CapabilityEntry,
  type CapabilityOutcome,
  type CapabilityProvider,
  fail,
  type InvocationContext,
} from "./types.ts";

/**
 * Granted folders (security §13). Every path is confined to a root: `..` is resolved away, the
 * deepest existing ancestor is realpath'd and must sit inside realpath(root), so symlinks that
 * leave a root are refused. Mutations never follow a symlink as the final component. Checks
 * and the operation are not atomic (a racing local process could swap a component); roots are
 * the owner's own folders, so that window is accepted.
 */
export interface FsRoot {
  path: string;
  mode: "ro" | "rw";
}

/** `fs.read` returns at most this many bytes, with `truncated: true` and the full `size`. */
export const FS_READ_MAX_BYTES = 1024 * 1024;
/** `fs.write` refuses larger content with `invalid_params`. */
export const FS_WRITE_MAX_BYTES = 16 * 1024 * 1024;
/** `fs.list` returns at most this many entries, with `truncated: true`. */
export const FS_LIST_MAX_ENTRIES = 1000;

type Encoding = "utf8" | "base64";

interface ResolvedRoot {
  real: string;
  mode: FsRoot["mode"];
}

interface Target {
  /** Real path: parents resolved, final component resolved only when following. */
  real: string;
  root: ResolvedRoot;
}

class Refusal {
  readonly outcome: CapabilityOutcome;
  constructor(outcome: CapabilityOutcome) {
    this.outcome = outcome;
  }
}

const PATH_SCHEMA = { type: "string", description: "Absolute path inside a granted root" };

export function createFsProvider(options: { roots: FsRoot[] }): CapabilityProvider {
  const roots = options.roots.map((r) => {
    if (!path.isAbsolute(r.path)) throw new Error(`fs root must be absolute: ${r.path}`);
    return { path: path.resolve(r.path), mode: r.mode };
  });

  /** Realpath of every existing root, most specific first; a missing root matches nothing. */
  async function resolvedRoots(): Promise<ResolvedRoot[]> {
    const out: ResolvedRoot[] = [];
    for (const r of roots) {
      try {
        out.push({ real: await fsp.realpath(r.path), mode: r.mode });
      } catch {
        // Missing or unreadable root: offers nothing.
      }
    }
    return out.sort((a, b) => b.real.length - a.real.length);
  }

  async function confine(raw: unknown, follow: boolean): Promise<Target> {
    if (typeof raw !== "string" || raw === "") throw refuse("invalid_params", "path is required");
    if (raw.includes("\0")) throw refuse("invalid_params", "path contains a NUL byte");
    if (!path.isAbsolute(raw)) throw refuse("invalid_params", "path must be absolute");
    const abs = path.resolve(raw);
    const parent = path.dirname(abs);
    let real = parent === abs ? abs : path.join(await realpathDeepest(parent), path.basename(abs));
    if (follow) {
      try {
        real = await fsp.realpath(real);
      } catch (err) {
        if (errCode(err) !== "ENOENT") throw err;
        await refuseDangling(real);
      }
    }
    const root = (await resolvedRoots()).find((r) => inside(real, r.real));
    if (!root) {
      throw refuse("forbidden", "path is outside the granted roots", { reason: "outside_roots" });
    }
    return { real, root };
  }

  function requireWritable(t: Target): void {
    if (t.root.mode !== "rw") {
      throw refuse("forbidden", "path is in a read-only root", { reason: "read_only_root" });
    }
  }

  async function refuseFinalSymlink(t: Target): Promise<Stats | null> {
    const st = await lstatOrNull(t.real);
    if (st?.isSymbolicLink()) {
      throw refuse("forbidden", "refusing to follow a symlink", { reason: "symlink" });
    }
    return st;
  }

  const list = handler(async (params) => {
    const p = record(params, ["path"]);
    const t = await confine(p.path, true);
    const dir = await fsp.opendir(t.real);
    const entries: { name: string; type: string; size: number; mtime: string }[] = [];
    let truncated = false;
    for await (const d of dir) {
      if (entries.length >= FS_LIST_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const st = await lstatOrNull(path.join(t.real, d.name));
      if (!st) continue;
      entries.push({
        name: d.name,
        type: kindOf(st),
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, result: { path: t.real, entries, truncated } };
  });

  const stat = handler(async (params) => {
    const p = record(params, ["path"]);
    const t = await confine(p.path, true);
    const st = await fsp.stat(t.real);
    return {
      ok: true,
      result: {
        path: t.real,
        type: kindOf(st),
        size: st.size,
        mode: (st.mode & 0o7777).toString(8),
        mtime: st.mtime.toISOString(),
        writable: t.root.mode === "rw",
      },
    };
  });

  const read = handler(async (params) => {
    const p = record(params, ["path", "encoding"]);
    const encoding = encodingOf(p.encoding);
    const t = await confine(p.path, true);
    const fh = await fsp.open(t.real, "r");
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw refuse("invalid_params", "path is not a regular file");
      const want = Math.min(st.size, FS_READ_MAX_BYTES);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const bytes = buf.subarray(0, got);
      const truncated = st.size > got;
      // Streaming decode holds back a code point split by the cap.
      const content =
        encoding === "base64"
          ? bytes.toString("base64")
          : new TextDecoder("utf-8").decode(bytes, { stream: truncated });
      return {
        ok: true,
        result: { path: t.real, encoding, content, size: st.size, bytes: got, truncated },
      };
    } finally {
      await fh.close();
    }
  });

  const write = handler(async (params, ctx) => {
    const p = record(params, ["path", "content", "encoding", "createParents"]);
    const encoding = encodingOf(p.encoding);
    if (typeof p.content !== "string") throw refuse("invalid_params", "content must be a string");
    const createParents = optionalBool(p.createParents, "createParents");
    const data = Buffer.from(p.content, encoding);
    if (data.length > FS_WRITE_MAX_BYTES) {
      throw refuse("invalid_params", `content exceeds ${FS_WRITE_MAX_BYTES} bytes`);
    }
    const t = await confine(p.path, false);
    requireWritable(t);
    const existing = await refuseFinalSymlink(t);
    if (existing && !existing.isFile()) throw refuse("invalid_params", "path is not a file");
    return attempt(ctx, "fs.write", t.real, data.length, async () => {
      const dir = path.dirname(t.real);
      if (createParents) await fsp.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(t.real)}.${randomUUID()}.tmp`);
      try {
        await fsp.writeFile(tmp, data, {
          flag: "wx",
          mode: existing ? existing.mode & 0o7777 : 0o666,
        });
        await fsp.rename(tmp, t.real);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return {
        summary: `wrote ${data.length} bytes`,
        result: { path: t.real, bytes: data.length },
      };
    });
  });

  const mkdir = handler(async (params, ctx) => {
    const p = record(params, ["path", "recursive"]);
    const recursive = optionalBool(p.recursive, "recursive");
    const t = await confine(p.path, false);
    requireWritable(t);
    await refuseFinalSymlink(t);
    return attempt(ctx, "fs.mkdir", t.real, undefined, async () => {
      const first = await fsp.mkdir(t.real, { recursive });
      const created = recursive ? first !== undefined : true;
      return {
        summary: created ? "created directory" : "directory exists",
        result: { path: t.real, created },
      };
    });
  });

  const remove = handler(async (params, ctx) => {
    const p = record(params, ["path", "recursive"]);
    const recursive = optionalBool(p.recursive, "recursive");
    // Not following: removing a symlink removes the link itself, never its target.
    const t = await confine(p.path, false);
    requireWritable(t);
    if ((await resolvedRoots()).some((r) => inside(r.real, t.real))) {
      throw refuse("forbidden", "refusing to remove a granted root", { reason: "root" });
    }
    const st = await fsp.lstat(t.real);
    return attempt(ctx, "fs.remove", t.real, undefined, async () => {
      if (st.isDirectory()) {
        if (recursive) await fsp.rm(t.real, { recursive: true });
        else await fsp.rmdir(t.real);
      } else {
        await fsp.unlink(t.real);
      }
      return { summary: `removed ${kindOf(st)}`, result: { path: t.real, removed: true } };
    });
  });

  const entries: CapabilityEntry[] = [
    {
      manifest: {
        name: "fs.list",
        description: "List a directory inside a granted folder.",
        sideEffect: "read",
        targetKind: "path",
        inputSchema: schema({ path: PATH_SCHEMA }, ["path"]),
      },
      handler: list,
    },
    {
      manifest: {
        name: "fs.stat",
        description: "Type, size, mode and mtime of a path inside a granted folder.",
        sideEffect: "read",
        targetKind: "path",
        inputSchema: schema({ path: PATH_SCHEMA }, ["path"]),
      },
      handler: stat,
    },
    {
      manifest: {
        name: "fs.read",
        description: `Read a file (first ${FS_READ_MAX_BYTES} bytes; \`truncated\` when larger).`,
        sideEffect: "read",
        targetKind: "path",
        inputSchema: schema(
          { path: PATH_SCHEMA, encoding: { type: "string", enum: ["utf8", "base64"] } },
          ["path"],
        ),
      },
      handler: read,
    },
    {
      manifest: {
        name: "fs.write",
        description: "Atomically write a file in a read-write granted folder.",
        sideEffect: "write",
        targetKind: "path",
        inputSchema: schema(
          {
            path: PATH_SCHEMA,
            content: { type: "string" },
            encoding: { type: "string", enum: ["utf8", "base64"] },
            createParents: { type: "boolean" },
          },
          ["path", "content"],
        ),
      },
      handler: write,
    },
    {
      manifest: {
        name: "fs.mkdir",
        description: "Create a directory in a read-write granted folder.",
        sideEffect: "write",
        targetKind: "path",
        inputSchema: schema({ path: PATH_SCHEMA, recursive: { type: "boolean" } }, ["path"]),
      },
      handler: mkdir,
    },
    {
      manifest: {
        name: "fs.remove",
        description: "Delete a file, link or directory in a read-write granted folder.",
        sideEffect: "destructive",
        targetKind: "path",
        inputSchema: schema({ path: PATH_SCHEMA, recursive: { type: "boolean" } }, ["path"]),
      },
      handler: remove,
    },
  ];

  return {
    id: "fs",
    async entries() {
      return roots.length === 0 ? [] : entries;
    },
    async status() {
      return { roots: roots.length };
    },
  };
}

type Handler = (params: unknown, ctx: InvocationContext) => Promise<CapabilityOutcome>;

/** Turns `Refusal`s and filesystem errors into error outcomes. */
function handler(fn: Handler): Handler {
  return async (params, ctx) => {
    try {
      return await fn(params, ctx);
    } catch (err) {
      if (err instanceof Refusal) return err.outcome;
      return { ok: false, error: mapFsError(err) };
    }
  };
}

/** Runs a mutation and attaches a receipt either way. Receipts never carry file contents. */
async function attempt(
  ctx: InvocationContext,
  kind: string,
  target: string,
  bytes: number | undefined,
  op: () => Promise<{ summary: string; result: unknown }>,
): Promise<CapabilityOutcome> {
  const payload: Record<string, unknown> = { path: target };
  if (bytes !== undefined) payload.bytes = bytes;
  try {
    const { summary, result } = await op();
    const receipt = ctx.receipt({ kind, outcome: "ok", summary, payload });
    return { ok: true, result, receipt };
  } catch (err) {
    const error = mapFsError(err);
    const receipt = ctx.receipt({ kind, outcome: "failed", summary: error.message, payload });
    return { ok: false, error, receipt };
  }
}

function mapFsError(err: unknown): ErrorPayload {
  const code = errCode(err);
  const syscall = (err as { syscall?: string } | null)?.syscall;
  const message = `${syscall ?? "fs"} failed: ${code ?? "error"}`;
  switch (code) {
    case "ENOENT":
      return { code: "not_found", message };
    case "EEXIST":
    case "ENOTEMPTY":
      return { code: "conflict", message };
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return { code: "forbidden", message, details: { reason: "os_permission" } };
    case "ENOTDIR":
    case "EISDIR":
    case "ELOOP":
    case "ENAMETOOLONG":
      return { code: "invalid_params", message };
    default:
      return { code: "internal", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Realpath of the deepest existing ancestor, with the missing tail appended verbatim. */
async function realpathDeepest(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...tail);
    } catch (err) {
      const code = errCode(err);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      await refuseDangling(cur);
      const up = path.dirname(cur);
      if (up === cur) throw err;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/** A component that lstat sees but realpath cannot resolve is a dangling symlink: refuse. */
async function refuseDangling(p: string): Promise<void> {
  const st = await lstatOrNull(p);
  if (st?.isSymbolicLink()) {
    throw refuse("forbidden", "path goes through a dangling symlink", { reason: "symlink" });
  }
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function inside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

function kindOf(st: Stats): "file" | "dir" | "symlink" | "other" {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function refuse(
  code: ErrorPayload["code"],
  message: string,
  details?: Record<string, unknown>,
): Refusal {
  return new Refusal(fail(code, message, details ? { details } : {}));
}

function record(params: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw refuse("invalid_params", "params must be an object");
  }
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw refuse("invalid_params", `unknown param: ${key}`);
  }
  return params as Record<string, unknown>;
}

function encodingOf(v: unknown): Encoding {
  if (v === undefined) return "utf8";
  if (v === "utf8" || v === "base64") return v;
  throw refuse("invalid_params", 'encoding must be "utf8" or "base64"');
}

function optionalBool(v: unknown, name: string): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw refuse("invalid_params", `${name} must be a boolean`);
  return v;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
