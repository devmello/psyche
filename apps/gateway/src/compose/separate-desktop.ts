import { createHash } from "node:crypto";
import { basename, posix } from "node:path";
import type { ToolRunContext } from "@psyche/agent-core";
import { hashCanonical } from "@psyche/audit";
import { getSetting, setSetting } from "@psyche/db";
import {
  type FolderAccessEnv,
  type FolderGrantEntry,
  resolveRequestedFolder,
} from "@psyche/permissions";
import {
  type ComputerSurface,
  type NodeClient,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import {
  canonicalHost,
  DEFAULT_DESKTOP_MEMORY,
  DESKTOP_NEVER_UNDER_HOME,
  DesktopContainers,
  type DesktopShare,
  type EgressTunnelHandler,
  matchAllowlist,
  parseAllowlist,
  validateDesktopMemory,
} from "@psyche/sandbox";
import { GuestSockets } from "../nodes/guest-sockets.ts";
import type { Gateway } from "../server.ts";
import { isRiskyLabel } from "./computer.ts";
import { folderAccessEnv } from "./protected-paths.ts";
import type { ComposedPart } from "./services.ts";

/**
 * The separate desktop, Gateway side (docs/design/linux-desktop-2026.md §5, §8; security §10,
 * §13): a rootless Podman container with its own apps and files, driven through the helper
 * inside it. `packages/sandbox/src/desktop.ts` runs the container; `nodes/guest-sockets.ts` pairs
 * the helper over a socket only that container can reach. This module is the policy around them:
 *
 * - **Routing.** `surface: "separate_desktop"` goes to the guest node of this desktop's container
 *   and to nothing else. It never falls back to the Host's helper, and no other surface ever
 *   reaches the guest (`clientFor`).
 * - **One task at a time**, and a workspace never crosses grants. A second task gets `conflict`.
 *   A task whose shares or internet differ from the last task's gets a clean `/workspace` (the
 *   Firefox profile is in it): the desktop is reset first.
 * - **Files.** None by default. A share is a folder the owner picked on its own card
 *   (`separate_desktop_share`: "Let the separate desktop read <folder>"), for this task only, and
 *   it creates no Host grant of any kind. Read-only unless the owner allows read-write on the card,
 *   which is asked fresh every time. Protected places (`protected-paths.ts` plus the Linux list in
 *   `@psyche/sandbox`) are refused here and again where the container is made.
 * - **Network.** Off. "Allow internet for this task" opens the egress proxy's tunnel for that Task
 *   with the Task's allowlist, nothing else; the container never has a network of its own. The
 *   tunnel closes when the Task ends.
 * - **Clipboard.** None, except the owner's "Paste into separate desktop".
 * - **Credentials.** The vault stays on the host. A login is typed only while internet is allowed
 *   for the task, only for an origin on its allowlist, on a fresh card each time that says the
 *   page can't be verified here.
 * - **Risky words.** File-local ones (delete, trash, remove, erase, clear, empty, discard) skip the
 *   card only when the whole list is safe to relax: no web reached, no login typed, not a browser,
 *   not a read-write share. Otherwise every word asks, as everywhere else.
 */

export const SEPARATE_DESKTOP_ID = "main";
export const SEPARATE_DESKTOP_SETTINGS = {
  /** `1g`..`16g` / `<n>m`; default `2g`. A security setting (`computerUse.*`). */
  memory: "computerUse.separateDesktop.memory",
  /** Written by the Gateway only: what the Settings row shows. */
  state: "computerUse.separateDesktop.state",
  /** Written by the owner's app: a new value resets the desktop (container and workspace). */
  reset: "computerUse.separateDesktop.reset",
  /** Written by the Gateway: a hash of the grants the workspace last served (no paths). */
  grants: "computerUse.separateDesktop.grants",
} as const;

export type SeparateDesktopPhase = "off" | "starting" | "running" | "stopping" | "failed";

export interface SeparateDesktopState {
  phase: SeparateDesktopPhase;
  /** `podman` or `docker`, when one was found. */
  engine?: string;
  /** False for a rootful engine: Settings shows `warning`. */
  rootless?: boolean;
  warning?: string;
  error?: string;
  /** Names of the shared folders and whether each is read-write. */
  shares?: { name: string; readWrite: boolean }[];
  internet?: boolean;
  /** Present and false when the system could not enforce the limit (shown in Settings). */
  memoryEnforced?: boolean;
  pidsEnforced?: boolean;
}

/** Linux places no share may be, on top of the Gateway's own protected roots. */
export function separateDesktopFolderEnv(home: string): FolderAccessEnv {
  const base = folderAccessEnv(home);
  const user = process.env.HOME ?? "";
  const extra = ["/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/root", "/var/lib", "/var/run"];
  // One list with the container's own check (`validateDesktopShares`), so the card and the mount
  // refuse the same places.
  const underHome = DESKTOP_NEVER_UNDER_HOME.map((p) => `${user}/${p}`);
  return {
    ...base,
    protectedRoots: [...(base.protectedRoots ?? []), ...extra, ...(user === "" ? [] : underHome)],
  };
}

/** Words that only touch files the separate desktop can reach anyway. */
const FILE_LOCAL = [
  "move to trash",
  "delete",
  "trash",
  "remove",
  "erase",
  "clear",
  "empty",
  "discard",
];

/** Linux browsers (design §5): a page in one can reach the web, so its words are never relaxed. */
const BROWSER_APPS = [
  "firefox",
  "chromium",
  "chrome",
  "brave",
  "vivaldi",
  "epiphany",
  "opera",
  "falkon",
  "librewolf",
  "browser",
];

const isBrowserApp = (app: string): boolean => {
  const a = app.toLowerCase();
  return BROWSER_APPS.some((b) => a.includes(b));
};

const underPath = (child: string, root: string): boolean =>
  child === root || child.startsWith(`${root}/`);

/** What decides whether a file-local word may skip the card (see `asksInSeparateDesktop`). */
export interface RiskContext {
  /** An egress tunnel is open now, or was open at any time during this task. */
  internetUsed: boolean;
  /** A saved login was typed in during this task. */
  credentialFilled: boolean;
  /** The app the action is aimed at (desktop file id); unknown means not relaxed. */
  app: string | undefined;
  /** The file or folder the action works on, as seen in the container; unknown means not relaxed when any share is read-write. */
  targetPath: string | undefined;
  /** Container paths of the read-write shares (`/shares/<name>`). */
  readWriteShares: readonly string[];
}

/**
 * Whether a label or key chord should ask inside the separate desktop.
 *
 * The full list (every risky word) applies, unless ALL of these hold, in which case the file-local
 * words (delete, trash, remove, erase, clear, empty, discard) are set aside because the action can
 * only touch the container's own files:
 * - no egress tunnel is open or was open in this task (what the page showed could be an attack),
 * - no saved login was typed in during this task,
 * - the target app is known and is not a browser,
 * - the target is known not to be under a read-write share (a read-write share is the owner's own
 *   file on the Host).
 * Words that reach the outside world (send, submit, purchase, buy, pay, transfer) ask either way:
 * "Delete and send" asks, "Delete" alone may not. Without a context nothing is relaxed.
 */
export function asksInSeparateDesktop(text: string | undefined, ctx?: RiskContext): boolean {
  if (text === undefined) return false;
  const label = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  if (ctx === undefined || !relaxed(ctx)) return isRiskyLabel(label);
  let rest = label;
  for (const w of FILE_LOCAL) rest = rest.split(` ${w} `).join("  ");
  return isRiskyLabel(rest);
}

function relaxed(ctx: RiskContext): boolean {
  if (ctx.internetUsed || ctx.credentialFilled) return false;
  if (ctx.app === undefined || ctx.app === "" || isBrowserApp(ctx.app)) return false;
  if (ctx.targetPath === undefined) return ctx.readWriteShares.length === 0;
  const target = posix.normalize(ctx.targetPath);
  return !ctx.readWriteShares.some((r) => underPath(target, r));
}

export const SEPARATE_DESKTOP_NOT_RUNNING =
  "the separate desktop is not running (or its helper is not connected)";

export interface SeparateDesktopDeps {
  desktop: DesktopContainers;
  guests: GuestSockets;
  /** `$PSYCHE_HOME`. */
  home: string;
  /** The memory setting's current value. */
  memory?: () => string | undefined;
  /** Egress for "Allow internet": the proxy's tunnel handler and per-scope allowlist. */
  egress?: {
    tunnel: EgressTunnelHandler;
    allowlist(scope: { kind: "task"; id: string }, domains: readonly string[]): void;
  };
  /**
   * The grants (shares and internet) of the task the workspace last served, so a task with other
   * grants never inherits it. Kept across Gateway restarts; unknown counts as different.
   */
  grants?: { read(): string | undefined; write(key: string): void };
  /** Publishes the Settings row's state. */
  report?: (state: SeparateDesktopState) => void;
  /** Unsaved work in the desktop's apps, from its helper (none known when it cannot say). */
  unsaved?: (client: NodeClient) => Promise<string[]>;
  /** Wait for the helper to pair after the container starts. */
  pairTimeoutMs?: number;
  logger?: {
    log(
      level: "info" | "warn",
      msg: string,
      fields?: Record<string, string | number | boolean | null>,
    ): void;
  };
}

/** The one task using the desktop. */
interface ActiveTask {
  id: string;
  shares: DesktopShare[];
  allow: string[];
  internet: { close(): void } | undefined;
  /** Sticky: once the web was reachable in this task, the relaxed risky-word rule is off. */
  internetUsed: boolean;
  credentialFilled: boolean;
}

/** What a credential card shows (`credential_fill`; the UI names the unverifiable destination). */
export interface CredentialCard {
  kind: "credential_fill";
  summary: string;
  details: {
    origin: string;
    item: string;
    /** Tells the card to say the page can't be verified inside the separate desktop. */
    separateDesktop: true;
  };
}

/** Identity of a set of grants: which folders at which access, and which origins. */
export function grantsKey(
  shares: readonly DesktopShare[],
  allow: readonly string[] | undefined,
): string {
  const rows = shares.map((s) => [s.name, s.source, s.readOnly]);
  rows.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  return createHash("sha256")
    .update(JSON.stringify({ rows, net: allow === undefined ? null : [...allow].sort() }))
    .digest("hex");
}

export type ShareOutcome =
  | { granted: true; share: DesktopShare }
  | { granted: false; status: string };

export class SeparateDesktop {
  readonly #deps: SeparateDesktopDeps;
  #task: ActiveTask | undefined;
  #watchers = 0;
  #running = false;
  #chain: Promise<unknown> = Promise.resolve();
  #shares: DesktopShare[] = [];
  #engine: { kind: string; rootless: boolean } | undefined;
  #limits: { memory: boolean; pids: boolean } = { memory: true, pids: true };

  constructor(deps: SeparateDesktopDeps) {
    this.#deps = deps;
  }

  /** Serializes lifecycle changes: one start, stop or reset at a time. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /**
   * The helper inside the desktop, for `surface: "separate_desktop"` calls. Only the guest node
   * bound to this desktop's container: not the Host's helper, not a node found by name or family.
   */
  clientFor(surface: ComputerSurface | undefined): NodeClient {
    if (surface !== "separate_desktop") {
      throw new PsycheError("invalid_params", "not a separate desktop call");
    }
    const client = this.#deps.guests.clientFor(SEPARATE_DESKTOP_ID);
    if (client === undefined) {
      throw new PsycheError("unavailable", SEPARATE_DESKTOP_NOT_RUNNING, {
        details: { reason: "separate_desktop_not_running" },
      });
    }
    return client;
  }

  /** Whether the helper inside is paired and connected. */
  get ready(): boolean {
    return this.#deps.guests.clientFor(SEPARATE_DESKTOP_ID) !== undefined;
  }

  /**
   * A folder to show to the desktop, on its own card (`separate_desktop_share`): "Let the separate
   * desktop read <folder>". The owner's pick is what is shared, for this task only. It creates no
   * Host grant of any kind: no file tool, no Settings entry, no conversation folder. Always asks;
   * an earlier grant of the same folder, to anything, does not count. Read-only unless the owner
   * allows read-write on the card.
   */
  async requestShare(
    deps: { broker: PermissionBroker; surfaces: readonly string[] },
    ctx: ToolRunContext,
    request: { path: string; reason: string; access: "read" | "read_write" },
  ): Promise<ShareOutcome> {
    if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
      throw new PsycheError("forbidden", "only the owner can share a folder");
    }
    const mode = request.access === "read_write" ? "rw" : "ro";
    const env = separateDesktopFolderEnv(this.#deps.home);
    const requested = await resolveRequestedFolder(request.path, env);
    const resolved =
      requested.status === "missing"
        ? { folderStatus: "missing" }
        : {
            folderStatus: requested.status,
            resolvedPath: requested.path,
            ...(requested.status === "blocked" ? { blockedReason: requested.reason } : {}),
          };
    const shown = requested.status === "missing" ? request.path : requested.path;
    const unattended = ctx.mode === "unattended";
    const issued = await deps.broker.requestApproval({
      kind: "separate_desktop_share",
      summary:
        `Let the separate desktop ${mode === "rw" ? "read and change" : "read"} ${shown}`.slice(
          0,
          300,
        ),
      details: {
        requestedPath: request.path,
        reason: request.reason,
        access: mode,
        target: "separate_desktop",
        ...resolved,
      },
      bindingHash: hashCanonical({
        tool: "separate_desktop_share",
        path: request.path,
        reason: request.reason,
        access: mode,
        resolved,
        threadId: ctx.threadId,
        callId: ctx.callId,
      }),
      grantKey: `separate_desktop_share|${mode}`,
      requestedBy: {
        runId: ctx.runId,
        taskId: ctx.taskId ?? null,
        threadId: ctx.threadId,
        toolCallId: ctx.callId,
      },
      sideEffect: mode === "rw" ? "write" : "read",
      surfaces: [...deps.surfaces],
      scopesOffered: ["once"],
      taint: ctx.taint,
      ...(ctx.taint && ctx.taintSources !== undefined
        ? { taintSources: [...ctx.taintSources] }
        : {}),
    });
    // An unattended task can't wait on a card; it is queued in the inbox and the task goes on without.
    if (unattended) return { granted: false, status: "queued" };
    const done = await deps.broker.awaitDecision(issued.approval.id, ctx.signal);
    const granted = done.details.granted as FolderGrantEntry | undefined;
    if (done.status !== "approved" || granted === undefined) {
      return { granted: false, status: done.status };
    }
    return {
      granted: true,
      share: {
        source: granted.path,
        name: this.#shareName(granted.path),
        readOnly: !(mode === "rw" && granted.mode === "rw"),
      },
    };
  }

  #shareName(path: string): string {
    const base =
      basename(path)
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "") || "folder";
    return base.slice(0, 56);
  }

  /**
   * Makes the desktop available to one Task, starting it if it is not running.
   *
   * - **One Task at a time.** A second Task gets `conflict` (`separate_desktop_busy`) and nothing is
   *   disturbed.
   * - **A workspace never crosses grants.** If this Task's grants (shares, internet and its
   *   allowlist) are not exactly those of the Task the workspace last served, the desktop is reset
   *   first: container, `/workspace` and the Firefox profile in it are deleted and recreated. A
   *   workspace that saw other shares or the web is never reused for a Task that did not get them.
   *   An unknown last grant counts as different.
   * - The same Task calling again replaces its own tunnel (the old one is closed first).
   */
  use(
    taskId: string,
    options: { shares?: readonly DesktopShare[]; internet?: { allow: readonly string[] } } = {},
  ): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#task !== undefined && this.#task.id !== taskId) {
        throw new PsycheError(
          "conflict",
          "the separate desktop is busy with another task; try again when it has finished",
          { details: { reason: "separate_desktop_busy" } },
        );
      }
      const shares = [...(options.shares ?? [])];
      const allow = options.internet === undefined ? undefined : [...options.internet.allow];
      // Re-entry: this Task's old tunnel closes before anything else, so it can never leak.
      const prior = this.#task;
      prior?.internet?.close();
      if (prior !== undefined) prior.internet = undefined;
      const key = grantsKey(shares, allow);
      if (this.#deps.grants?.read() !== key) {
        // Different grants from the last Task's: a clean workspace.
        if (this.#running) await this.#stopNow(true);
        await this.#deps.desktop.reset(SEPARATE_DESKTOP_ID);
      } else if (this.#running && JSON.stringify(shares) !== JSON.stringify(this.#shares)) {
        await this.#stopNow(true);
      }
      if (!this.#running) await this.#startNow(shares);
      this.#deps.grants?.write(key);
      const task: ActiveTask = prior ?? {
        id: taskId,
        shares,
        allow: [],
        internet: undefined,
        internetUsed: false,
        credentialFilled: false,
      };
      task.shares = shares;
      this.#task = task;
      if (allow !== undefined) {
        try {
          await this.#openInternet(task, allow);
        } catch (err) {
          // Fail closed: a task that asked for internet and can't have it does not run with less
          // of a promise than it asked for, and nothing stays up.
          this.#task = undefined;
          await this.#stopNow(true).catch(() => undefined);
          throw err;
        }
      }
      this.#report({ phase: "running" });
    });
  }

  async #startNow(shares: DesktopShare[]): Promise<void> {
    this.#report({ phase: "starting" });
    try {
      const opened = await this.#deps.guests.open(SEPARATE_DESKTOP_ID);
      const memory = validateDesktopMemory(this.#deps.memory?.() ?? DEFAULT_DESKTOP_MEMORY);
      const started = await this.#deps.desktop.start({
        id: SEPARATE_DESKTOP_ID,
        socketPath: opened.socketPath,
        token: opened.token,
        shares,
        memory,
        protectedRoots: separateDesktopFolderEnv(this.#deps.home).protectedRoots ?? [],
      });
      const deadline = Date.now() + (this.#deps.pairTimeoutMs ?? 20_000);
      while (this.#deps.guests.clientFor(SEPARATE_DESKTOP_ID) === undefined) {
        if (Date.now() > deadline) {
          throw new PsycheError(
            "unavailable",
            "the separate desktop started but its helper did not connect",
            { details: { reason: "guest_not_paired" } },
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      this.#running = true;
      this.#shares = shares;
      this.#engine = started.backend;
      this.#limits = started.limits;
      this.#deps.logger?.log("info", "separate desktop started", {
        engine: started.backend.kind,
        shares: shares.length,
      });
      if (!started.limits.memory) {
        this.#deps.logger?.log(
          "warn",
          "separate desktop: memory limit not enforced on this system",
        );
      }
      if (!started.limits.pids) {
        this.#deps.logger?.log(
          "warn",
          "separate desktop: process limit not enforced on this system",
        );
      }
    } catch (err) {
      // Fail closed: nothing half-started stays up, and the socket and token are gone.
      await this.#teardown();
      const e = PsycheError.from(err);
      this.#report({ phase: "failed", error: e.message });
      throw e;
    }
  }

  async #teardown(): Promise<void> {
    this.#deps.guests.close(SEPARATE_DESKTOP_ID);
    await this.#deps.desktop.stop(SEPARATE_DESKTOP_ID).catch(() => undefined);
    this.#running = false;
    this.#shares = [];
  }

  async #openInternet(task: ActiveTask, allow: readonly string[]): Promise<void> {
    const egress = this.#deps.egress;
    if (egress === undefined) {
      throw new PsycheError(
        "unavailable",
        "internet for the separate desktop is not available here",
        { details: { reason: "no_egress_proxy" } },
      );
    }
    const scope = { kind: "task" as const, id: task.id };
    egress.allowlist(scope, allow);
    task.allow = [...allow];
    task.internetUsed = true;
    task.internet = await this.#deps.desktop.openEgress(SEPARATE_DESKTOP_ID, scope, egress.tunnel);
  }

  /**
   * A Task is finished with the desktop: its tunnel closes at once. The desktop stops when no watch
   * view is open, unless its apps have unsaved changes (then this throws `conflict` and the
   * container stays up for the owner to decide, as the virtual screen does) or `force` is set.
   */
  release(taskId: string, options: { force?: boolean } = {}): Promise<void> {
    return this.#exclusive(async () => {
      const task = this.#task;
      if (task === undefined || task.id !== taskId) return;
      task.internet?.close();
      task.internet = undefined;
      this.#task = undefined;
      if (this.#watchers > 0 || !this.#running) return;
      await this.#stopNow(options.force === true);
    });
  }

  /** The watch view opened or closed; a closing one may be the last thing holding the desktop. */
  watching(open: boolean): Promise<void> {
    this.#watchers = Math.max(0, this.#watchers + (open ? 1 : -1));
    if (open || this.#watchers > 0) return Promise.resolve();
    return this.#exclusive(async () => {
      if (this.#task === undefined && this.#running) await this.#stopNow(false);
    });
  }

  async #stopNow(force: boolean): Promise<void> {
    if (!force && this.#deps.unsaved !== undefined) {
      const client = this.#deps.guests.clientFor(SEPARATE_DESKTOP_ID);
      const apps = client === undefined ? [] : await this.#deps.unsaved(client).catch(() => []);
      if (apps.length > 0) {
        throw new PsycheError("conflict", "the separate desktop has unsaved changes", {
          details: { reason: "unsaved_changes", apps },
        });
      }
    }
    this.#report({ phase: "stopping" });
    this.#task?.internet?.close();
    if (this.#task !== undefined) this.#task.internet = undefined;
    await this.#teardown();
    this.#report({ phase: "off" });
  }

  /** "Reset separate desktop": everything it holds is gone, the container and its workspace. */
  reset(): Promise<void> {
    return this.#exclusive(async () => {
      this.#task?.internet?.close();
      this.#task = undefined;
      await this.#teardown();
      await this.#deps.desktop.reset(SEPARATE_DESKTOP_ID);
      this.#report({ phase: "off" });
    });
  }

  /** Stops everything without asking (Gateway shutdown). */
  shutdown(): Promise<void> {
    return this.#exclusive(async () => {
      this.#task?.internet?.close();
      this.#task = undefined;
      await this.#teardown();
    });
  }

  /**
   * Whether a label or key chord in this Task's desktop should ask (`asksInSeparateDesktop`, with
   * the state of this Task: web reached, login typed, read-write shares). Not this Task's: asks.
   */
  asks(
    taskId: string,
    text: string | undefined,
    target: { app?: string; path?: string } = {},
  ): boolean {
    const task = this.#task;
    if (task === undefined || task.id !== taskId) return asksInSeparateDesktop(text);
    return asksInSeparateDesktop(text, {
      internetUsed: task.internetUsed,
      credentialFilled: task.credentialFilled,
      app: target.app,
      targetPath: target.path,
      readWriteShares: task.shares.filter((s) => !s.readOnly).map((s) => `/shares/${s.name}`),
    });
  }

  /**
   * Typing a saved login into the desktop. Only while internet is allowed for this Task, only for
   * an origin on that Task's allowlist, and every time on a fresh card (`approve` is asked each
   * call; nothing is remembered). The card says the destination can't be verified in here: the
   * helper only reports what the page claims. The secret is read after the approval, typed once
   * and dropped; nothing is kept here or in the container.
   */
  async fillCredential(
    taskId: string,
    request: {
      origin: string;
      item: string;
      approve(card: CredentialCard): Promise<boolean>;
      read(): Promise<string>;
      type(secret: string): Promise<void>;
    },
  ): Promise<boolean> {
    const task = this.#task;
    if (task === undefined || task.id !== taskId || task.internet === undefined) {
      throw new PsycheError(
        "forbidden",
        "a login can be typed into the separate desktop only while internet is allowed for the task",
        { details: { reason: "credential_needs_internet" } },
      );
    }
    if (!originAllowed(request.origin, task.allow)) {
      throw new PsycheError("forbidden", "that site is not on this task's list of allowed sites", {
        details: { reason: "credential_origin_not_allowed" },
      });
    }
    const card: CredentialCard = {
      kind: "credential_fill",
      summary: `Type a saved login for ${request.origin} into the separate desktop`,
      details: { origin: request.origin, item: request.item, separateDesktop: true },
    };
    if (!(await request.approve(card))) return false;
    task.credentialFilled = true;
    await request.type(await request.read());
    return true;
  }

  #report(state: SeparateDesktopState): void {
    const out: SeparateDesktopState = { ...state };
    if (this.#engine !== undefined) {
      out.engine = this.#engine.kind;
      out.rootless = this.#engine.rootless;
      if (!this.#engine.rootless) {
        out.warning =
          "This container engine runs as root. Use rootless Podman for the separate desktop.";
      }
    }
    if (state.phase === "running") {
      out.shares = this.#shares.map((s) => ({ name: s.name, readWrite: !s.readOnly }));
      out.internet = this.#task?.internet !== undefined;
      if (!this.#limits.memory) out.memoryEnforced = false;
      if (!this.#limits.pids) out.pidsEnforced = false;
    }
    this.#deps.report?.(out);
  }
}

/** Whether `origin` (a URL) is one the task's allowlist admits. */
export function originAllowed(origin: string, allow: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = canonicalHost(url.hostname);
  if (host === undefined) return false;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return matchAllowlist(parseAllowlist(allow), host, port) !== undefined;
}

/**
 * The owner's clipboard stays out of the desktop and the desktop's stays in: the only crossing is
 * the owner's own "Paste into separate desktop" from the watch view.
 */
export function assertSeparateDesktopClipboard(
  direction: "paste_into" | "to_host" | "from_host",
): void {
  if (direction !== "paste_into") {
    throw new PsycheError(
      "forbidden",
      "the separate desktop shares no clipboard with this computer",
      { details: { reason: "separate_desktop_clipboard" } },
    );
  }
}

/** What `createSandboxEgress` gives (`ComposedSandbox.egress`). */
export interface SandboxEgressLike {
  readonly egressTunnel: EgressTunnelHandler;
  egressAllowlist(scope: { kind: "task"; id: string }, domains: readonly string[]): void;
}

/** The part: mounts the desktop on Linux only, and nothing runs until a Task asks for it. */
export interface ComposedSeparateDesktop extends ComposedPart {
  readonly separateDesktop: SeparateDesktop;
}

export function composeSeparateDesktop(
  options: {
    platform?: NodeJS.Platform;
    desktop?: DesktopContainers;
    /** The sandbox part's egress proxy, looked up when a Task asks for internet. */
    egress?: () => SandboxEgressLike | undefined;
    unsaved?: SeparateDesktopDeps["unsaved"];
    onSettingChanged?: (listener: (change: { key: string; after: unknown }) => void) => void;
  } = {},
): (services: { home: string }) => ComposedSeparateDesktop {
  return (services) => {
    let gateway: Gateway | undefined;
    let guests: GuestSockets | undefined;
    const holder: { current: SeparateDesktop | undefined } = { current: undefined };
    const desktop = options.desktop ?? new DesktopContainers();
    const inert = (options.platform ?? process.platform) !== "linux";
    return {
      // The real object needs the running Gateway; until `start` nothing can reach it.
      get separateDesktop(): SeparateDesktop {
        if (holder.current === undefined) {
          throw new PsycheError("unavailable", "the separate desktop is not available yet");
        }
        return holder.current;
      },
      async start(gw) {
        if (inert) return;
        gateway = gw;
        const ctx = gw.context;
        guests = new GuestSockets({ ctx, home: services.home });
        // A Gateway that crashed with a desktop up leaves a container with a spent token and no
        // socket, and a device that is still valid: remove both.
        await desktop.reconcile().catch(() => []);
        guests.revokeStale();
        const report = (state: SeparateDesktopState) => {
          const entry = setSetting(ctx.db, SEPARATE_DESKTOP_SETTINGS.state, state);
          ctx.bus.bumpStateVersion();
          ctx.bus.publish("settings.changed", { entries: [entry] });
        };
        const sd = new SeparateDesktop({
          desktop,
          guests,
          home: services.home,
          memory: () => {
            const v = getSetting(ctx.db, SEPARATE_DESKTOP_SETTINGS.memory)?.value;
            return typeof v === "string" ? v : undefined;
          },
          report,
          grants: {
            read: () => {
              const v = getSetting(ctx.db, SEPARATE_DESKTOP_SETTINGS.grants)?.value;
              return typeof v === "string" ? v : undefined;
            },
            write: (key) => void setSetting(ctx.db, SEPARATE_DESKTOP_SETTINGS.grants, key),
          },
          logger: ctx.log,
          get egress() {
            const e = options.egress?.();
            return e === undefined
              ? undefined
              : {
                  tunnel: e.egressTunnel,
                  allowlist: (sc: { kind: "task"; id: string }, d: readonly string[]) =>
                    e.egressAllowlist(sc, d),
                };
          },
          ...(options.unsaved === undefined ? {} : { unsaved: options.unsaved }),
        });
        holder.current = sd;
        options.onSettingChanged?.((c) => {
          if (
            c.key === SEPARATE_DESKTOP_SETTINGS.reset &&
            c.after !== null &&
            c.after !== undefined
          ) {
            void sd.reset().catch((err) =>
              ctx.log.log("warn", "separate desktop reset failed", {
                error: PsycheError.from(err).message,
              }),
            );
          }
        });
      },
      async stop() {
        await holder.current?.shutdown().catch(() => undefined);
        guests?.closeAll();
        void gateway;
      },
    };
  };
}
