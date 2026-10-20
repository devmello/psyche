import { createHash } from "node:crypto";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { PsycheError, type SandboxMount, type SandboxScope } from "@psyche/protocol";
import type { ToolRunContext } from "../registry.ts";

/**
 * Coding workspaces (V10). A task (or, outside a task, a thread) opens a repository folder with
 * `code.open`; every other `code.*` tool names that root and is refused for a root its scope has
 * not opened. The root is a real absolute path inside a folder the owner granted: the broker's
 * folder policy decides the open, and the executors re-check the live grants on every call.
 */

/** Where the repository appears inside the sandbox (`code.run`). */
export const REPO_MOUNT = "/workspace/repo";

/** A folder in `permissions.policy.folders`. */
export interface CodingFolderGrant {
  path: string;
  mode: "ro" | "rw";
}

export interface CodingWorkspace {
  id: string;
  /** Real absolute path of the repository root on the host. */
  root: string;
  /** `rw` when the owner granted the folder read-write; edits, runs and git writes need it. */
  mode: "ro" | "rw";
  /** `task:<id>` or `thread:<id>`. */
  scopeKey: string;
  openedAt: string;
}

export function scopeKeyOf(ctx: Pick<ToolRunContext, "taskId" | "threadId">): string {
  return ctx.taskId === undefined ? `thread:${ctx.threadId}` : `task:${ctx.taskId}`;
}

/** The normalized absolute form the broker and the executors compare (no file system access). */
export function canonicalRoot(path: string): string {
  if (path.includes("\0")) throw new PsycheError("invalid_params", "NUL in path");
  if (!isAbsolute(path)) throw new PsycheError("invalid_params", `${path} is not absolute`);
  const r = resolve(path);
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
}

export function isUnder(child: string, root: string): boolean {
  if (root === "/") return child.startsWith("/");
  return child === root || child.startsWith(`${root}/`);
}

/**
 * A path the model gave relative to the root, resolved and confined to it. `..` resolves first,
 * so `src/../../etc` is judged as the folder it names. Absolute paths are accepted when they lie
 * under the root.
 */
export function resolveInRoot(root: string, path: string): string {
  if (path.includes("\0")) throw new PsycheError("invalid_params", "NUL in path");
  const full = isAbsolute(path) ? resolve(path) : resolve(root, normalize(path));
  if (!isUnder(full, root)) {
    throw new PsycheError("forbidden", `${path} is outside the workspace ${root}`);
  }
  return full;
}

/** Root-relative form for output (`.` for the root itself). */
export function relativeTo(root: string, full: string): string {
  const r = relative(root, full);
  return r === "" ? "." : r.split(sep).join("/");
}

/** `.git` and everything in it: hooks and config there run with the owner's git. */
export function isGitInternal(root: string, full: string): boolean {
  const rel = relativeTo(root, full);
  return rel.split("/").some((part) => part.toLowerCase() === ".git");
}

/** The longest granted folder containing `path`, as the broker picks it. */
export function grantFor(
  path: string,
  folders: readonly CodingFolderGrant[] | undefined,
): CodingFolderGrant | undefined {
  let best: CodingFolderGrant | undefined;
  for (const f of folders ?? []) {
    const root = canonicalRoot(f.path);
    if (isUnder(path, root) && (best === undefined || root.length > best.path.length)) {
      best = { path: root, mode: f.mode };
    }
  }
  return best;
}

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class CodingWorkspaces {
  readonly #byScope = new Map<string, Map<string, CodingWorkspace>>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  open(ctx: Pick<ToolRunContext, "taskId" | "threadId">, root: string, mode: "ro" | "rw") {
    const scopeKey = scopeKeyOf(ctx);
    let roots = this.#byScope.get(scopeKey);
    if (roots === undefined) {
      roots = new Map();
      this.#byScope.set(scopeKey, roots);
    }
    const ws: CodingWorkspace = {
      id: `cw_${short(`${scopeKey}|${root}`)}`,
      root,
      mode,
      scopeKey,
      openedAt: roots.get(root)?.openedAt ?? this.#now().toISOString(),
    };
    roots.set(root, ws);
    return { ...ws };
  }

  /** The workspace `root` names in the call's scope, or `forbidden`. */
  get(ctx: Pick<ToolRunContext, "taskId" | "threadId">, root: string): CodingWorkspace {
    const ws = this.#byScope.get(scopeKeyOf(ctx))?.get(root);
    if (ws === undefined) {
      throw new PsycheError(
        "forbidden",
        `${root} is not an open coding workspace in this ${ctx.taskId === undefined ? "thread" : "task"}; call code.open first`,
      );
    }
    return { ...ws };
  }

  list(ctx: Pick<ToolRunContext, "taskId" | "threadId">): CodingWorkspace[] {
    return [...(this.#byScope.get(scopeKeyOf(ctx))?.values() ?? [])].map((w) => ({ ...w }));
  }

  /** Forget a task's or thread's workspaces (its sandbox stays until the runner reaps it). */
  close(scopeKey: string): void {
    this.#byScope.delete(scopeKey);
  }
}

/** The sandbox scope `code.run` uses for a workspace; a networked run gets its own container. */
export function sandboxScopeOf(ws: CodingWorkspace, network: "none" | "proxy"): SandboxScope {
  return { kind: "project", id: network === "none" ? ws.id : `${ws.id}-net` };
}

/**
 * The repository read-write at `/workspace/repo`, with its `.git` read-only on top: a command
 * in the sandbox can change the working tree but never plant hooks or config that the owner's
 * own git would run on the host (security §5.1; the SharedRoot lesson in §13).
 */
export function repoMounts(ws: CodingWorkspace, gitDir: boolean): SandboxMount[] {
  return [
    { source: ws.root, target: REPO_MOUNT, readOnly: ws.mode !== "rw" },
    ...(gitDir
      ? [{ source: `${ws.root}/.git`, target: `${REPO_MOUNT}/.git`, readOnly: true }]
      : []),
  ];
}
