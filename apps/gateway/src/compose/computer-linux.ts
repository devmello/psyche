import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import type { HelperNode } from "./computer.ts";
import { COMPUTER_USE_ENABLED } from "./computer-settings.ts";

/**
 * Linux direct computer use shares its state with Settings → Computer use through two settings
 * (`computerUse.*` is a security namespace, so only the owner's device changes the second one):
 *
 * - `computerUse.linux`, written here and read by the UI:
 *   `{ session, desktop, backend, allowed, a11yEnabled, killSwitch, warnings, checkedAt }`, from the Linux
 *   helper's `portal.status` and `a11y.status`. Refreshed when the helper comes online, after a
 *   computer-use session ends, after a revoke, and when `computerUse.enabled` changes.
 * - `computerUse.linuxRevoke`, written by the UI: an ISO timestamp set when the owner clicks
 *   Revoke. A changed value makes the Gateway call `portal.revoke` on the running helper, then
 *   refresh `computerUse.linux`. With no helper running it is kept pending and applied when the
 *   helper next connects.
 *
 * Turning computer use on asks the helper to expose app structure (`a11y.enable {enabled: true}`);
 * turning it off restores it (`{enabled: false}`). A helper that connects later gets the current
 * value. Owner rule: turning computer use off, and Revoke, never start a helper (neither the
 * graphical unit nor the headless one). All of it is best effort: a failure is logged, never
 * thrown.
 * Only created on a Linux Gateway; no other platform calls these capabilities.
 */

/** The helper units psyched starts on demand (`apps/cli/src/systemd-unit.ts` renders both). */
export const GRAPHICAL_HELPER_UNIT = "psyche-helper.service";
export const HEADLESS_HELPER_UNIT = "psyche-helper-headless.service";

/** Which helper unit to start: the graphical one only when this user has a graphical session. */
export function helperUnitFor(graphicalSession: boolean): string {
  return graphicalSession ? GRAPHICAL_HELPER_UNIT : HEADLESS_HELPER_UNIT;
}

/** Runs a command with fixed arguments (no shell) and returns stdout; rejects on failure. */
export type RunCommand = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;

/**
 * The absolute path of a system tool: `/usr/bin` first, then `/bin`. Never resolved through
 * `PATH`, which the user manager lets `environment.d` extend.
 */
export function systemBin(name: string, exists: (p: string) => boolean = existsSync): string {
  for (const dir of ["/usr/bin", "/bin"]) {
    if (exists(`${dir}/${name}`)) return `${dir}/${name}`;
  }
  return `/usr/bin/${name}`;
}

const runFile: RunCommand = (file, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 10_000, windowsHide: true, ...(signal === undefined ? {} : { signal }) },
      (err, stdout) => (err === null ? resolve(String(stdout)) : reject(err)),
    );
  });

const GRAPHICAL_TYPES = new Set(["x11", "wayland", "mir"]);

function props(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Whether the user manager's environment names a display that is really there: `DISPLAY=:<n>`
 * with `/tmp/.X11-unix/X<n>`, or `WAYLAND_DISPLAY` with its socket in `XDG_RUNTIME_DIR`. A value
 * left behind by a desktop that has since stopped (sway, i3 or startx with
 * `dbus-update-activation-environment --systemd`, under linger) has no socket and does not count.
 */
export function liveDisplayIn(
  envText: string,
  uid: number,
  exists: (p: string) => boolean = existsSync,
): boolean {
  const env = props(envText);
  const x = /^:(\d+)(\.\d+)?$/.exec(env.DISPLAY ?? "");
  if (x !== null && exists(`/tmp/.X11-unix/X${x[1]}`)) return true;
  const wl = env.WAYLAND_DISPLAY ?? "";
  if (wl === "" || wl.includes("..")) return false;
  if (wl.startsWith("/")) return exists(wl);
  if (wl.includes("/")) return false;
  const runtime = env.XDG_RUNTIME_DIR?.startsWith("/") ? env.XDG_RUNTIME_DIR : `/run/user/${uid}`;
  return exists(`${runtime}/${wl}`);
}

/** The `show-session` properties `hasGraphicalSession` reads, as fixed arguments. */
const SESSION_PROPS = ["Type", "State", "User", "Remote", "Seat"].flatMap((p) => ["-p", p]);

/**
 * Whether this user has a graphical session, as the helper would see one. A session of this uid
 * counts when logind says its `Type` is x11, wayland or mir and its `State` is not `closing`.
 * logind's own `Display=` is not used: it names the user's primary session, which an SSH or
 * console login also is. A `tty` session (startx, sway from a console) counts only when it is
 * local (`Remote=no`) on a seat (`Seat` set; SSH and pty sessions have none), and the user
 * manager's environment names a display whose socket exists (`liveDisplayIn`).
 *
 * "Graphical" is what logind says (owner decision, 2026-11-20): a desktop logind does not know
 * about (WSLg, a container, startx without importing `DISPLAY`) gets the private screen, not
 * `direct`. A session that vanishes between `list-sessions` and `show-session` is skipped; only a
 * failed `list-sessions` (no loginctl, no logind) counts as no session.
 */
export async function hasGraphicalSession(
  run: RunCommand = runFile,
  uid: number | undefined = process.getuid?.(),
  signal?: AbortSignal,
  exists: (p: string) => boolean = existsSync,
): Promise<boolean> {
  if (uid === undefined) return false;
  const loginctl = systemBin("loginctl");
  let listed: string;
  try {
    listed = await run(loginctl, ["list-sessions", "--no-legend"], signal);
  } catch {
    return false;
  }
  let tty = false;
  for (const line of listed.split("\n")) {
    if (signal?.aborted === true) return false;
    const [id, sessionUid] = line.trim().split(/\s+/);
    if (id === undefined || id === "" || sessionUid !== String(uid)) continue;
    let p: Record<string, string>;
    try {
      p = props(await run(loginctl, ["show-session", id, ...SESSION_PROPS], signal));
    } catch {
      // Gone since it was listed (`No session '<id>' known`): the other sessions still count.
      continue;
    }
    if (p.User !== undefined && p.User !== String(uid)) continue;
    if (p.State === "closing") continue;
    if (GRAPHICAL_TYPES.has(p.Type ?? "")) return true;
    if (p.Type === "tty" && p.Remote === "no" && (p.Seat ?? "") !== "") tty = true;
  }
  if (!tty) return false;
  try {
    const env = await run(systemBin("systemctl"), ["--user", "show-environment"], signal);
    return liveDisplayIn(env, uid, exists);
  } catch {
    return false;
  }
}

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** How long one logind answer is reused. Every call site shares it. */
export const GRAPHICAL_SESSION_TTL_MS = 3_000;

/** `hasGraphicalSession` behind a short cache; the signal is the caller's. */
export type GraphicalSessionCheck = (signal?: AbortSignal) => Promise<boolean>;

/**
 * One logind lookup for every caller within `ttlMs`: `resolveTarget` and the unit choice in
 * `startHelperWithSystemd`. Callers that arrive while a lookup runs wait for that one. A
 * caller's signal cuts its own wait short (`cancelled`); the lookup's spawns are killed once
 * every caller waiting on it has given up, and a cancelled lookup is never cached.
 */
export function cachedGraphicalSession(
  lookup: (signal: AbortSignal) => Promise<boolean> = (signal) =>
    hasGraphicalSession(runFile, process.getuid?.(), signal),
  opts: { ttlMs?: number; now?: () => number } = {},
): GraphicalSessionCheck {
  const ttl = opts.ttlMs ?? GRAPHICAL_SESSION_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { value: boolean; at: number } | undefined;
  interface Lookup {
    promise: Promise<boolean>;
    ctrl: AbortController;
    waiters: number;
  }
  let inflight: Lookup | undefined;
  const cancelled = () => new PsycheError("cancelled", "The call was cancelled");

  function begin(): Lookup {
    const ctrl = new AbortController();
    const entry: Lookup = { ctrl, waiters: 0, promise: Promise.resolve(false) };
    entry.promise = lookup(ctrl.signal)
      .then((value) => {
        if (!ctrl.signal.aborted) cached = { value, at: now() };
        return value;
      })
      .finally(() => {
        if (inflight === entry) inflight = undefined;
      });
    return entry;
  }

  return async (signal) => {
    if (cached !== undefined && now() - cached.at < ttl) return cached.value;
    if (signal?.aborted === true) throw cancelled();
    inflight ??= begin();
    const entry = inflight;
    entry.waiters++;
    try {
      if (signal === undefined) return await entry.promise;
      return await new Promise<boolean>((resolve, reject) => {
        const onAbort = () => reject(cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
        entry.promise.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      });
    } finally {
      entry.waiters--;
      // Read again: the signal may have aborted while this caller waited.
      if (isAborted(signal) && entry.waiters === 0 && inflight === entry) {
        inflight = undefined;
        entry.ctrl.abort();
      }
    }
  };
}

/**
 * Linux only: starts the Host helper (`systemctl --user start <unit>`, no shell, fixed arguments).
 * With a graphical session it is `psyche-helper.service` as always; without one it is the
 * headless unit (B0). Rejects when systemd cannot start it; the error carries `unit`.
 */
export async function startHelperWithSystemd(
  signal?: AbortSignal,
  run: RunCommand = runFile,
  graphical: () => Promise<boolean> = () => hasGraphicalSession(run, undefined, signal),
): Promise<void> {
  const unit = helperUnitFor(await graphical());
  try {
    await run(systemBin("systemctl"), ["--user", "start", unit], signal);
  } catch (err) {
    throw Object.assign(new Error(`could not start ${unit}`, { cause: err }), { unit });
  }
}

export const COMPUTER_USE_LINUX = "computerUse.linux";
export const COMPUTER_USE_LINUX_REVOKE = "computerUse.linuxRevoke";

const SESSIONS = ["wayland", "x11", "headless"] as const;
const DESKTOPS = ["gnome", "kde", "wlroots", "other"] as const;
const BACKENDS = ["portal", "wlroots", "x11", "none"] as const;
const CALL_TIMEOUT_MS = 10_000;

export interface LinuxAccessState {
  session: (typeof SESSIONS)[number];
  desktop: (typeof DESKTOPS)[number] | null;
  backend: (typeof BACKENDS)[number];
  /** A restore token is stored: screen and input access stays allowed until revoked. */
  allowed: boolean;
  a11yEnabled: boolean | null;
  /**
   * The helper has a working Stop (the X11 Escape grab, or a watched portal session). False: it
   * refuses computer use until one works. Null: the helper does not say (an older helper).
   */
  killSwitch: boolean | null;
  warnings: string[];
  checkedAt: string;
}

export interface LinuxComputerStateDeps {
  db: PsycheDb;
  /** Tells the apps a setting changed (`settings.changed`). */
  publishEntry(entry: ReturnType<typeof setSetting>): void;
  /** The connected Host helper, if any. */
  helper(): HelperNode | undefined;
  logger?: Logger;
  now?: () => Date;
}

export interface LinuxComputerState {
  /** Reads the helper's state into `computerUse.linux` (never starts the helper). */
  refresh(): Promise<void>;
  /**
   * The Host helper connected: apply a Revoke that waited for it, set app structure to match
   * computer use (on, or put back when off), then refresh.
   */
  helperOnline(): Promise<void>;
  /** `settings.changed` entries: `computerUse.enabled` and `computerUse.linuxRevoke`. */
  onChanged(entries: readonly { key: string; value: unknown }[]): void;
  /** Resolves when the queued work is done (tests). */
  settled(): Promise<void>;
}

const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" ? list.find((x) => x === v) : undefined;

export function createLinuxComputerState(deps: LinuxComputerStateDeps): LinuxComputerState {
  const now = deps.now ?? (() => new Date());
  let enabled = getSetting(deps.db, COMPUTER_USE_ENABLED)?.value === true;
  let lastRevoke = getSetting(deps.db, COMPUTER_USE_LINUX_REVOKE)?.value;
  let chain: Promise<void> = Promise.resolve();

  const warn = (msg: string, err: unknown) =>
    deps.logger?.log("warn", msg, { code: PsycheError.from(err).code });

  /** Serializes the work: a revoke and a refresh never interleave. */
  function queue(task: () => Promise<void>): void {
    chain = chain.then(task).catch((err: unknown) => warn("linux computer-use sync failed", err));
  }

  /** A Revoke that arrived while no helper was running: applied when one connects. */
  let pendingRevoke = false;

  /** Calls the connected helper. Never starts one: off and Revoke start nothing (owner rule). */
  async function call(
    capability: string,
    params: Record<string, unknown>,
    node: HelperNode | undefined = deps.helper(),
  ): Promise<Record<string, unknown> | undefined> {
    if (node === undefined) return undefined;
    const res = await node.client.invoke(capability, params, { timeoutMs: CALL_TIMEOUT_MS });
    if (!res.ok) {
      deps.logger?.log("warn", `${capability} failed`, { code: res.error?.code ?? "internal" });
      return undefined;
    }
    return (res.result ?? {}) as Record<string, unknown>;
  }

  async function refreshNow(): Promise<void> {
    if (deps.helper() === undefined) return;
    const portal = await call("portal.status", {});
    if (portal === undefined) return;
    const a11y = await call("a11y.status", {});
    const state: LinuxAccessState = {
      session: pick(SESSIONS, portal.session) ?? "headless",
      desktop: pick(DESKTOPS, portal.desktop) ?? null,
      backend: pick(BACKENDS, portal.backend) ?? "none",
      allowed: portal.allowed === true,
      a11yEnabled:
        a11y !== undefined && a11y.available === true && typeof a11y.enabled === "boolean"
          ? a11y.enabled
          : null,
      killSwitch: typeof portal.killSwitch === "boolean" ? portal.killSwitch : null,
      warnings: Array.isArray(portal.warnings)
        ? portal.warnings.filter((w): w is string => typeof w === "string").slice(0, 8)
        : [],
      checkedAt: now().toISOString(),
    };
    deps.publishEntry(setSetting(deps.db, COMPUTER_USE_LINUX, state));
  }

  async function enabledChanged(on: boolean): Promise<void> {
    // Only a running helper is told. One that connects later gets the current value from
    // `helperOnline`, so turning it off never starts a helper just to put the setting back.
    await call("a11y.enable", { enabled: on });
    await refreshNow();
  }

  /** Revokes on the running helper, or records it for the next one that connects. */
  async function revokeNow(): Promise<void> {
    const node = deps.helper();
    if (node === undefined) {
      pendingRevoke = true;
      return;
    }
    await call("portal.revoke", {}, node);
    pendingRevoke = false;
  }

  async function revoke(): Promise<void> {
    await revokeNow();
    await refreshNow();
  }

  return {
    refresh: () => {
      queue(refreshNow);
      return chain;
    },
    helperOnline: () => {
      queue(async () => {
        if (pendingRevoke) await revokeNow();
        // Off: restore app structure in case Psyche turned it on (the helper keeps it otherwise).
        await call("a11y.enable", { enabled });
        await refreshNow();
      });
      return chain;
    },
    onChanged(entries) {
      for (const e of entries) {
        if (e.key === COMPUTER_USE_ENABLED) {
          const on = e.value === true;
          if (on === enabled) continue;
          enabled = on;
          queue(() => enabledChanged(on));
        } else if (e.key === COMPUTER_USE_LINUX_REVOKE) {
          if (typeof e.value !== "string" || e.value === "" || e.value === lastRevoke) continue;
          lastRevoke = e.value;
          queue(revoke);
        }
      }
    },
    settled: () => chain,
  };
}
