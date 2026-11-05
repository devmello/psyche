import { basename } from "node:path";
import type { ToolRunContext } from "@psyche/agent-core";
import { getSetting, setSetting } from "@psyche/db";
import type { FolderAccessEnv, FolderGrantEntry } from "@psyche/permissions";
import {
  type ComputerSurface,
  type NodeClient,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import {
  DEFAULT_DESKTOP_MEMORY,
  DesktopContainers,
  type DesktopShare,
  type EgressTunnelHandler,
  validateDesktopMemory,
} from "@psyche/sandbox";
import { GuestSockets } from "../nodes/guest-sockets.ts";
import type { Gateway } from "../server.ts";
import { isRiskyLabel } from "./computer.ts";
import { askForFolder } from "./folder-access.ts";
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
 * - **Files.** None by default. A share is a folder the owner picked on a folder-access card
 *   (`request_folder_access`'s own flow): read-only unless the owner allowed read-write on that
 *   card, and a read-write share always asks a fresh card (a folder granted earlier is never
 *   upgraded silently). Anything protected (`protected-paths.ts` plus the Linux extras below) is
 *   refused here and again where the container is made.
 * - **Network.** Off. "Allow internet for this task" opens the egress proxy's tunnel for that Task
 *   with the Task's allowlist, nothing else: the container never has a network of its own.
 * - **Clipboard.** None, except the owner's "Paste into separate desktop".
 * - **Credentials.** The vault stays on the host: one approval, one secret, typed by the helper
 *   into one field, never kept here or in the container.
 * - **Risky words.** File-local ones (delete, trash, remove, erase, clear, empty, discard) don't ask
 *   inside the separate desktop, because it can only touch its own files and the shares the owner
 *   chose; everything else, including every word that reaches the outside world, still asks.
 */

export const SEPARATE_DESKTOP_ID = "main";
export const SEPARATE_DESKTOP_SETTINGS = {
  /** `1g`..`16g` / `<n>m`; default `2g`. A security setting (`computerUse.*`). */
  memory: "computerUse.separateDesktop.memory",
  /** Written by the Gateway only: what the Settings row shows. */
  state: "computerUse.separateDesktop.state",
  /** Written by the owner's app: a new value resets the desktop (container and workspace). */
  reset: "computerUse.separateDesktop.reset",
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
}

/** Linux places no share may be, on top of the Gateway's own protected roots. */
export function separateDesktopFolderEnv(home: string): FolderAccessEnv {
  const base = folderAccessEnv(home);
  const user = process.env.HOME ?? "";
  const extra = ["/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/root", "/var/lib", "/var/run"];
  const underHome = [
    ".config",
    ".local/share",
    ".local/state",
    ".cache",
    ".mozilla",
    ".thunderbird",
    ".pki",
    ".password-store",
    ".var",
  ].map((p) => `${user}/${p}`);
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

/**
 * Whether a label or key chord should ask inside the separate desktop. The file-local words are
 * set aside first, so "Delete and send" still asks (it sends), and "Delete" alone does not.
 */
export function asksInSeparateDesktop(text: string | undefined): boolean {
  if (text === undefined) return false;
  let rest = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  for (const w of FILE_LOCAL) rest = rest.split(` ${w} `).join("  ");
  return isRiskyLabel(rest);
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

interface Held {
  shares: DesktopShare[];
  internet: { close(): void } | undefined;
}

export class SeparateDesktop {
  readonly #deps: SeparateDesktopDeps;
  /** Tasks using the desktop right now. */
  readonly #tasks = new Map<string, Held>();
  #watchers = 0;
  #running = false;
  #chain: Promise<unknown> = Promise.resolve();
  #shares: DesktopShare[] = [];

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
   * A folder to share, through the same card as `request_folder_access`. Read-only unless the
   * owner allows read-write on that card; a read-write request always gets a fresh card. Returns
   * the share to pass to `use`, or `undefined` when the owner said no or the card is queued.
   */
  async requestShare(
    deps: {
      broker: PermissionBroker;
      surfaces: readonly string[];
      grantedFolders?: (threadId: string) => readonly FolderGrantEntry[];
    },
    ctx: ToolRunContext,
    request: { path: string; reason: string; access: "read" | "read_write" },
  ): Promise<DesktopShare | undefined> {
    const result = await askForFolder(
      {
        broker: deps.broker,
        surfaces: deps.surfaces,
        folderEnv: () => separateDesktopFolderEnv(this.#deps.home),
        // A read-write share never rides on an earlier grant.
        grantedFolders:
          request.access === "read_write" ? () => [] : (id) => deps.grantedFolders?.(id) ?? [],
      },
      ctx,
      request,
    );
    const out = result.output as { granted?: boolean; path?: string; access?: string };
    if (out.granted !== true || typeof out.path !== "string") return undefined;
    return {
      source: out.path,
      name: this.#shareName(out.path),
      readOnly: !(request.access === "read_write" && out.access === "read_write"),
    };
  }

  #shareName(path: string): string {
    const base =
      basename(path)
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "") || "folder";
    const taken = new Set([...this.#tasks.values()].flatMap((h) => h.shares.map((s) => s.name)));
    let name = base.slice(0, 56);
    for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 56)}-${i}`;
    return name;
  }

  /**
   * Makes the desktop available to a Task, starting it if it is not running. `shares` are exactly
   * the folders this Task may reach; if the desktop is running with other shares it is restarted
   * with these, unless another Task holds it. `internet` opens the egress tunnel for this Task
   * with its allowlist.
   */
  use(
    taskId: string,
    options: { shares?: readonly DesktopShare[]; internet?: { allow: readonly string[] } } = {},
  ): Promise<void> {
    return this.#exclusive(async () => {
      const wanted = [...(options.shares ?? [])];
      const key = (s: readonly DesktopShare[]) =>
        JSON.stringify([...s].map((x) => [x.name, x.source, x.readOnly]).sort());
      const others = [...this.#tasks.keys()].filter((id) => id !== taskId);
      const merged = [...this.#tasks.entries()]
        .filter(([id]) => id !== taskId)
        .flatMap(([, h]) => h.shares);
      const shares = [...merged, ...wanted];
      if (this.#running && key(shares) !== key(this.#shares)) {
        if (others.length > 0) {
          throw new PsycheError(
            "conflict",
            "the separate desktop is busy with another task; try again when it has finished",
            { details: { reason: "separate_desktop_busy" } },
          );
        }
        await this.#stopNow(true);
      }
      if (!this.#running) await this.#startNow(shares);
      const held: Held = { shares: wanted, internet: undefined };
      this.#tasks.set(taskId, held);
      if (options.internet !== undefined)
        await this.#openInternet(taskId, held, options.internet.allow);
      this.#report({ phase: "running" });
    });
  }

  async #startNow(shares: DesktopShare[]): Promise<void> {
    this.#report({ phase: "starting" });
    try {
      const backend = await this.#deps.desktop.requireBackend();
      const opened = await this.#deps.guests.open(SEPARATE_DESKTOP_ID);
      const memory = validateDesktopMemory(this.#deps.memory?.() ?? DEFAULT_DESKTOP_MEMORY);
      await this.#deps.desktop.start({
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
            {
              details: { reason: "guest_not_paired" },
            },
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      this.#running = true;
      this.#shares = shares;
      this.#deps.logger?.log("info", "separate desktop started", {
        engine: backend.kind,
        shares: shares.length,
      });
      this.#engine = backend;
    } catch (err) {
      // Fail closed: nothing half-started stays up, and the socket and token are gone.
      await this.#teardown();
      const e = PsycheError.from(err);
      this.#report({ phase: "failed", error: e.message });
      throw e;
    }
  }

  #engine: { kind: string; rootless: boolean } | undefined;

  async #teardown(): Promise<void> {
    this.#deps.guests.close(SEPARATE_DESKTOP_ID);
    await this.#deps.desktop.stop(SEPARATE_DESKTOP_ID).catch(() => undefined);
    this.#running = false;
    this.#shares = [];
  }

  async #openInternet(taskId: string, held: Held, allow: readonly string[]): Promise<void> {
    const egress = this.#deps.egress;
    if (egress === undefined) {
      throw new PsycheError(
        "unavailable",
        "internet for the separate desktop is not available here",
        {
          details: { reason: "no_egress_proxy" },
        },
      );
    }
    const scope = { kind: "task" as const, id: taskId };
    egress.allowlist(scope, allow);
    held.internet = await this.#deps.desktop.openEgress(SEPARATE_DESKTOP_ID, scope, egress.tunnel);
  }

  /**
   * A Task is finished with the desktop. It stops when no Task holds it and no watch view is
   * open, unless its apps have unsaved changes (then this throws `conflict` and the desktop stays
   * up for the owner to decide, as the virtual screen does) or `force` is set.
   */
  release(taskId: string, options: { force?: boolean } = {}): Promise<void> {
    return this.#exclusive(async () => {
      const held = this.#tasks.get(taskId);
      held?.internet?.close();
      this.#tasks.delete(taskId);
      if (this.#tasks.size > 0 || this.#watchers > 0 || !this.#running) return;
      await this.#stopNow(options.force === true);
    });
  }

  /** The watch view opened or closed; a closing one may be the last thing holding the desktop. */
  watching(open: boolean): Promise<void> {
    this.#watchers = Math.max(0, this.#watchers + (open ? 1 : -1));
    if (open || this.#watchers > 0) return Promise.resolve();
    return this.#exclusive(async () => {
      if (this.#tasks.size === 0 && this.#running) await this.#stopNow(false);
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
    for (const held of this.#tasks.values()) held.internet?.close();
    await this.#teardown();
    this.#report({ phase: "off" });
  }

  /** "Reset separate desktop": everything it holds is gone, the container and its workspace. */
  reset(): Promise<void> {
    return this.#exclusive(async () => {
      for (const held of this.#tasks.values()) held.internet?.close();
      this.#tasks.clear();
      await this.#teardown();
      await this.#deps.desktop.reset(SEPARATE_DESKTOP_ID);
      this.#report({ phase: "off" });
    });
  }

  /** Stops everything without asking (Gateway shutdown). */
  shutdown(): Promise<void> {
    return this.#exclusive(async () => {
      for (const held of this.#tasks.values()) held.internet?.close();
      this.#tasks.clear();
      await this.#teardown();
    });
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
      out.internet = [...this.#tasks.values()].some((h) => h.internet !== undefined);
    }
    this.#deps.report?.(out);
  }
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
      {
        details: { reason: "separate_desktop_clipboard" },
      },
    );
  }
}

/**
 * Typing a saved login into the desktop: one approval, one secret, typed by the helper into one
 * field. The secret is read after the approval, handed to the helper and dropped; this function
 * keeps nothing, and the container is never given a copy to keep.
 */
export async function fillSeparateDesktopCredential(steps: {
  approve(): Promise<boolean>;
  read(): Promise<string>;
  type(secret: string): Promise<void>;
}): Promise<boolean> {
  if (!(await steps.approve())) return false;
  await steps.type(await steps.read());
  return true;
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
