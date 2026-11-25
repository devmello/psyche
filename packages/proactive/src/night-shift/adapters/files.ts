import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { asRecord, preview, str } from "./common.ts";
import type {
  Adapter,
  CaptureContext,
  CaptureOk,
  CaptureResult,
  CheckResult,
  InverseCall,
  Json,
  StagedCall,
} from "./types.ts";

/**
 * Files (§2.3, §2.4; psyche-permissions §3d). `files_move` and `files_rename` inside rw-granted
 * folders, judged on file descriptors, never on paths alone:
 *
 * - The source is opened `O_NOFOLLOW` and judged from `fstat` (regular file, `nlink` 1, `dev:ino`,
 *   size, mtime). The path the fd belongs to (`realpath`) must lead to that same `dev:ino`, so a
 *   link swapped in between is caught. If the open fails (EACCES, a link, a FIFO) the item is
 *   refused: there is no by-path fallback.
 * - The destination parent is resolved with `realpath`, must be a directory, and its `dev:ino` is
 *   recorded. The destination itself must be absent (`lstat`, so a dangling link counts as there).
 * - Source real path and destination parent real path must lie inside an rw grant, judged at use
 *   time from `grants()`. The deepest covering grant decides, so an `ro` folder under an `rw`
 *   parent is `ro`. A `grants()` that throws refuses. `..` segments, NUL, relative paths and macOS
 *   magic prefixes are refused outright, never normalised, because `link/..` is not the lexical
 *   parent.
 *
 * One call stages one file operation: use `splitFilesCall` first for a multi-item `files_move`.
 */

export interface FileGrant {
  root: string;
  mode: "ro" | "rw";
}

export interface FilesDeps {
  /** The live grants, read at every use. Must fail closed: throw when they cannot be read. */
  grants: () => readonly FileGrant[];
  /** The owner's home, for a leading `~`. Defaults to the process user's home. */
  home?: string;
}

const TOOLS = ["files_move", "files_rename"] as const;

const FOLD_CASE = process.platform !== "linux";

/** A path as APFS compares names (`ſ` is `s`); byte for byte on Linux. */
export function foldName(p: string): string {
  return FOLD_CASE
    ? p.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC")
    : p;
}

function under(child: string, root: string): boolean {
  const c = foldName(child);
  const r = foldName(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

const MAGIC = /^\/\.(nofollow|resolve|vol)(\/|$)/;

/** Why a model-supplied path is refused before it touches the disk, or undefined. */
export function badPath(p: unknown): string | undefined {
  if (typeof p !== "string" || p === "") return "bad_path";
  if (p.includes("\0")) return "bad_path";
  if (!isAbsolute(p)) return "relative_path";
  if (p.split(/[\\/]+/).includes("..")) return "dotdot";
  if (MAGIC.test(p)) return "magic_path";
  return undefined;
}

/** A leading `~` or `~/` means the owner's home. `~user` is not expanded (and stays relative). */
function expandHome(p: unknown, deps: FilesDeps): unknown {
  if (typeof p !== "string") return p;
  if (p === "~") return deps.home ?? homedir();
  if (p.startsWith("~/")) return join(deps.home ?? homedir(), p.slice(2));
  return p;
}

/**
 * Before any file system call on a model-supplied path: it must lie, lexically and name-folded,
 * under a grant root (the root as written or its realpath). A path that is not never reaches the
 * disk, so a hostile name cannot make Psyche stat, open or follow anything outside the grants.
 * The realpath and `dev:ino` checks that follow decide what the lexical check cannot.
 */
function lexicallyGranted(path: string, deps: FilesDeps): Refusal | undefined {
  let grants: readonly FileGrant[];
  try {
    grants = deps.grants();
  } catch {
    return { reason: "grants_unreadable" };
  }
  for (const g of grants) {
    const roots = [g.root];
    try {
      roots.push(realpathSync.native(g.root));
    } catch {
      // The root as written still counts; the real check refuses if it names nothing.
    }
    for (const r of roots) if (r !== sep && under(path, r)) return undefined;
  }
  return { reason: "outside_grant" };
}

function badName(n: string): boolean {
  return (
    n === "" ||
    n === "." ||
    n === ".." ||
    n.length > 255 ||
    n.includes("/") ||
    n.includes("\\") ||
    n.includes("\0")
  );
}

interface Identity {
  id: string;
  size: string;
  mtime: string;
}

function ident(st: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): Identity {
  return { id: `${st.dev}:${st.ino}`, size: String(st.size), mtime: String(st.mtimeNs) };
}

type Refusal = { reason: string };

function grantMode(real: string, deps: FilesDeps): "rw" | "ro" | Refusal {
  let grants: readonly FileGrant[];
  try {
    grants = deps.grants();
  } catch {
    return { reason: "grants_unreadable" };
  }
  let best: { len: number; mode: "ro" | "rw" } | undefined;
  for (const g of grants) {
    let root: string;
    try {
      root = realpathSync.native(g.root);
    } catch {
      continue; // a root that names nothing covers nothing
    }
    if (root === sep) continue; // too broad to vouch for anything
    if (!under(real, root)) continue;
    // The deepest root decides; on equal depth ro wins.
    if (!best || root.length > best.len || (root.length === best.len && g.mode === "ro")) {
      best = { len: root.length, mode: g.mode };
    }
  }
  return best ? best.mode : { reason: "outside_grant" };
}

function inRw(real: string, deps: FilesDeps): Refusal | undefined {
  const m = grantMode(real, deps);
  if (typeof m === "object") return m;
  return m === "rw" ? undefined : { reason: "not_writable" };
}

/** Open the source by fd and judge it. Never falls back to a path check. */
function readSource(path: string): { real: string; id: Identity } | Refusal {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { reason: code === "ENOENT" ? "source_gone" : "source_unopenable" };
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return { reason: "not_a_file" };
    if (st.nlink !== 1n) return { reason: "hard_linked" };
    let real: string;
    try {
      real = realpathSync.native(path);
      const back = lstatSync(real, { bigint: true });
      if (back.dev !== st.dev || back.ino !== st.ino) return { reason: "swapped" };
    } catch {
      return { reason: "swapped" };
    }
    return { real, id: ident(st) };
  } finally {
    closeSync(fd);
  }
}

interface DestParent {
  real: string;
  id: string;
}

function readDestParent(path: string): DestParent | Refusal {
  const bad = badPath(path);
  if (bad) return { reason: bad };
  try {
    const real = realpathSync.native(path);
    const st = statSync(real, { bigint: true });
    if (!st.isDirectory()) return { reason: "dest_parent_not_dir" };
    return { real, id: `${st.dev}:${st.ino}` };
  } catch {
    return { reason: "dest_parent_missing" };
  }
}

/** True when nothing, not even a dangling link, is at `p`. */
function absent(p: string): boolean | Refusal {
  try {
    lstatSync(p);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? true : { reason: "dest_unreadable" };
  }
}

/** Names a staged file item must never create or land in: dot names (`.git`, `.env`, `.zshrc`). */
function dotted(name: string): boolean {
  return name.startsWith(".");
}

/** Dot names refused on both ends: a hidden source file or folder, a hidden destination. */
function hiddenRefusal(
  sourceReal: string,
  destParentReal: string,
  deps: FilesDeps,
): Refusal | undefined {
  if (dotted(basename(sourceReal)) || hiddenBelowGrant(dirname(sourceReal), deps)) {
    return { reason: "hidden_source" };
  }
  return hiddenBelowGrant(destParentReal, deps) ? { reason: "hidden_destination" } : undefined;
}

/** Dot components below a grant root: moving into a hidden folder is refused. */
function hiddenBelowGrant(real: string, deps: FilesDeps): boolean {
  let grants: readonly FileGrant[];
  try {
    grants = deps.grants();
  } catch {
    return true;
  }
  for (const g of grants) {
    let root: string;
    try {
      root = realpathSync.native(g.root);
    } catch {
      continue;
    }
    if (root !== sep && under(real, root) && real.length > root.length) {
      const rel = real.slice(root.length).split(sep);
      if (rel.some((c) => c !== "" && dotted(c))) return true;
    }
  }
  return false;
}

interface Op {
  path: string;
  to: string;
  name: string | undefined;
}

function parseOp(call: StagedCall, deps: FilesDeps): Op | Refusal {
  const a = call.args;
  if (call.tool === "files_rename") {
    const path = expandHome(a.path, deps);
    const name = str(a.name);
    const bad = badPath(path);
    if (bad) return { reason: bad };
    if (!name) return { reason: "bad_name" };
    return { path: path as string, to: dirname(path as string), name };
  }
  const items = a.items;
  if (!Array.isArray(items) || items.length !== 1) return { reason: "one_item_per_call" };
  const it = items[0] as Record<string, unknown>;
  const path = expandHome(it.path, deps);
  const to = expandHome(it.to, deps);
  const bad = badPath(path) ?? badPath(to);
  if (bad) return { reason: bad };
  if (it.name !== undefined && (typeof it.name !== "string" || it.name === "")) {
    return { reason: "bad_name" };
  }
  return { path: path as string, to: to as string, name: str(it.name) };
}

/** Split a multi-item `files_move` into one call per file, which is what `capture` accepts. */
export function splitFilesCall(call: StagedCall): StagedCall[] {
  if (call.tool !== "files_move" || !Array.isArray(call.args.items)) return [call];
  return (call.args.items as unknown[]).map((it) => ({
    tool: "files_move",
    args: { items: [it] },
  }));
}

interface FilePre {
  sourcePath: string;
  sourceReal: string;
  sourceId: string;
  sourceParentId: string;
  size: string;
  mtime: string;
  destParent: string;
  destParentId: string;
  destPath: string;
  /** The `to` the call named, kept so a folded call can be rebuilt. */
  to: string;
  name: string;
}

function pre(c: CaptureOk): FilePre | undefined {
  const p = asRecord(c.precondition);
  const need = [
    "sourcePath",
    "sourceReal",
    "sourceId",
    "sourceParentId",
    "size",
    "mtime",
    "destParent",
    "destParentId",
    "destPath",
    "to",
    "name",
  ];
  if (!need.every((k) => typeof p[k] === "string")) return undefined;
  return p as unknown as FilePre;
}

function moveCall(sourcePath: string, to: string, name: string): StagedCall {
  return { tool: "files_move", args: { items: [{ path: sourcePath, to, name }] } };
}

export function filesAdapter(deps: FilesDeps): Adapter {
  async function capture(call: StagedCall, ctx?: CaptureContext): Promise<CaptureResult> {
    const op = parseOp(call, deps);
    if ("reason" in op) return { ok: false, reason: op.reason };
    const lex = lexicallyGranted(op.path, deps) ?? lexicallyGranted(op.to, deps);
    if (lex) return { ok: false, reason: lex.reason };

    const parent = readDestParent(op.to);
    if ("reason" in parent) return { ok: false, reason: parent.reason };
    const name = op.name ?? basename(op.path);
    if (badName(name) || dotted(name)) return { ok: false, reason: "bad_name" };
    const destPath = join(parent.real, name);

    // Folding (§2.4): the source is an earlier item's staged destination.
    let sourceReal: string | undefined;
    try {
      sourceReal = join(realpathSync.native(dirname(op.path)), basename(op.path));
    } catch {
      sourceReal = undefined;
    }
    if (sourceReal !== undefined) {
      for (const p of ctx?.pending ?? []) {
        if (!TOOLS.includes(p.call.tool as (typeof TOOLS)[number])) continue;
        const e = pre(p.capture);
        if (!e || foldName(e.destPath) !== foldName(sourceReal)) continue;
        return fold(e, p.capture, parent, name, destPath);
      }
    }

    const src = readSource(op.path);
    if ("reason" in src) return { ok: false, reason: src.reason };
    const srcParent = readDestParent(dirname(src.real));
    if ("reason" in srcParent) return { ok: false, reason: srcParent.reason };
    const bad =
      inRw(src.real, deps) ?? inRw(parent.real, deps) ?? hiddenRefusal(src.real, parent.real, deps);
    if (bad) return { ok: false, reason: bad.reason };
    if (foldName(destPath) === foldName(src.real)) return { ok: false, reason: "noop" };
    const free = absent(destPath);
    if (typeof free === "object") return { ok: false, reason: free.reason };
    if (!free) return { ok: false, reason: "destination_exists" };

    const precondition: FilePre = {
      sourcePath: op.path,
      sourceReal: src.real,
      sourceId: src.id.id,
      sourceParentId: srcParent.id,
      size: src.id.size,
      mtime: src.id.mtime,
      destParent: parent.real,
      destParentId: parent.id,
      destPath,
      to: op.to,
      name,
    };
    return {
      ok: true,
      target: src.id.id,
      precondition: precondition as unknown as Json,
      before: { path: src.real },
    };
  }

  function fold(
    earlier: FilePre,
    earlierCap: CaptureOk,
    parent: DestParent,
    name: string,
    destPath: string,
  ): CaptureResult {
    const bad = inRw(parent.real, deps) ?? hiddenRefusal(earlier.sourceReal, parent.real, deps);
    if (bad) return { ok: false, reason: bad.reason };
    if (foldName(destPath) === foldName(earlier.sourceReal)) {
      return { ok: false, reason: "folds_to_noop" };
    }
    const free = absent(destPath);
    if (typeof free === "object") return { ok: false, reason: free.reason };
    if (!free) return { ok: false, reason: "destination_exists" };
    const merged: FilePre = {
      ...earlier,
      destParent: parent.real,
      destParentId: parent.id,
      destPath,
      to: parent.real,
      name,
    };
    return {
      ok: true,
      target: earlierCap.target,
      folds: [earlierCap.target],
      call: moveCall(earlier.sourcePath, parent.real, name),
      precondition: merged as unknown as Json,
      before: earlierCap.before,
    };
  }

  return {
    tools: TOOLS,
    capture,

    async check(_call, capture): Promise<CheckResult> {
      const p = pre(capture);
      if (!p) return { fresh: false, reason: "bad_precondition" };
      const lex =
        lexicallyGranted(p.sourcePath, deps) ??
        lexicallyGranted(p.to, deps) ??
        lexicallyGranted(p.destPath, deps);
      if (lex) return { fresh: false, reason: lex.reason };
      const src = readSource(p.sourcePath);
      if ("reason" in src) return { fresh: false, reason: src.reason };
      if (src.real !== p.sourceReal) return { fresh: false, reason: "source_moved" };
      if (src.id.id !== p.sourceId) return { fresh: false, reason: "source_replaced" };
      if (src.id.size !== p.size || src.id.mtime !== p.mtime) {
        return { fresh: false, reason: "source_changed" };
      }
      const parent = readDestParent(p.to);
      if ("reason" in parent) return { fresh: false, reason: parent.reason };
      if (parent.real !== p.destParent || parent.id !== p.destParentId) {
        return { fresh: false, reason: "dest_parent_changed" };
      }
      // The grant is judged now, not as it was when the item was staged.
      const bad =
        inRw(src.real, deps) ??
        inRw(parent.real, deps) ??
        hiddenRefusal(src.real, parent.real, deps);
      if (bad) return { fresh: false, reason: bad.reason };
      const free = absent(p.destPath);
      if (typeof free === "object") return { fresh: false, reason: free.reason };
      if (!free) return { fresh: false, reason: "destination_exists" };
      return { fresh: true };
    },

    preview(call, capture) {
      const p = pre(capture);
      const rename = call.tool === "files_rename";
      return preview("file", rename ? "Rename a file" : "Move a file", [
        ["From", p?.sourceReal ?? "?"],
        ["To", p?.destPath ?? "?"],
      ]);
    },

    inverse(_call, capture): InverseCall | undefined {
      const p = pre(capture);
      if (!p) return undefined;
      return {
        tool: "files_move",
        args: {
          items: [{ path: p.destPath, to: dirname(p.sourceReal), name: basename(p.sourceReal) }],
        },
      };
    },

    async postState(_call, capture): Promise<Json> {
      const p = pre(capture);
      if (!p) return null;
      const dest = readSource(p.destPath);
      return "reason" in dest ? null : { id: dest.id.id, real: dest.real };
    },

    async checkInverse(_call, capture, post): Promise<CheckResult> {
      const p = pre(capture);
      const want = asRecord(post);
      if (!p || typeof want.id !== "string") return { fresh: false, reason: "no_post_state" };
      const lex =
        lexicallyGranted(p.destPath, deps) ?? lexicallyGranted(dirname(p.sourceReal), deps);
      if (lex) return { fresh: false, reason: lex.reason };
      const dest = readSource(p.destPath);
      if ("reason" in dest) return { fresh: false, reason: dest.reason };
      if (dest.id.id !== want.id || dest.real !== want.real) {
        return { fresh: false, reason: "destination_replaced" };
      }
      // The old path must be free and its folder still the one recorded, inside an rw grant now.
      const oldParent = readDestParent(dirname(p.sourceReal));
      if ("reason" in oldParent) return { fresh: false, reason: oldParent.reason };
      if (oldParent.id !== p.sourceParentId) return { fresh: false, reason: "old_parent_changed" };
      const bad = inRw(dest.real, deps) ?? inRw(oldParent.real, deps);
      if (bad) return { fresh: false, reason: bad.reason };
      const free = absent(join(oldParent.real, basename(p.sourceReal)));
      if (typeof free === "object") return { fresh: false, reason: free.reason };
      if (!free) return { fresh: false, reason: "old_path_taken" };
      return { fresh: true };
    },
  };
}
