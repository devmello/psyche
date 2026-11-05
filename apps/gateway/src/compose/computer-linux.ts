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
 *   `{ session, desktop, backend, allowed, a11yEnabled, warnings, checkedAt }`, from the Linux
 *   helper's `portal.status` and `a11y.status`. Refreshed when the helper comes online, after a
 *   computer-use session ends, after a revoke, and when `computerUse.enabled` changes.
 * - `computerUse.linuxRevoke`, written by the UI: an ISO timestamp set when the owner clicks
 *   Revoke. A changed value makes the Gateway call `portal.revoke` on the helper (started on
 *   demand), then refresh `computerUse.linux`.
 *
 * Turning computer use on asks the helper to expose app structure (`a11y.enable {enabled: true}`;
 * also when the helper connects while it is on); turning it off restores it (`{enabled: false}`,
 * starting the helper if needed). All of it is best effort: a failure is logged, never thrown.
 * Only created on a Linux Gateway; no other platform calls these capabilities.
 */

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
  warnings: string[];
  checkedAt: string;
}

export interface LinuxComputerStateDeps {
  db: PsycheDb;
  /** Tells the apps a setting changed (`settings.changed`). */
  publishEntry(entry: ReturnType<typeof setSetting>): void;
  /** The connected Host helper, if any. */
  helper(): HelperNode | undefined;
  /** Starts the helper when it is not running. */
  startHelper?(signal: AbortSignal): Promise<void>;
  /** How long to wait for a started helper to connect (default 5 s, polling every 100 ms). */
  helperWait?: { timeoutMs: number; pollMs: number };
  logger?: Logger;
  now?: () => Date;
}

export interface LinuxComputerState {
  /** Reads the helper's state into `computerUse.linux` (never starts the helper). */
  refresh(): Promise<void>;
  /** The Host helper connected: enable app structure when computer use is on, then refresh. */
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

  async function helperFor(start: boolean): Promise<HelperNode | undefined> {
    const node = deps.helper();
    if (node !== undefined || !start || deps.startHelper === undefined) return node;
    try {
      await deps.startHelper(new AbortController().signal);
    } catch (err) {
      warn("starting the helper failed", err);
      return undefined;
    }
    const wait = deps.helperWait ?? { timeoutMs: 5_000, pollMs: 100 };
    const deadline = Date.now() + wait.timeoutMs;
    for (;;) {
      const up = deps.helper();
      if (up !== undefined || Date.now() >= deadline) return up;
      await new Promise((r) => setTimeout(r, wait.pollMs));
    }
  }

  async function call(
    capability: string,
    params: Record<string, unknown>,
    start = false,
  ): Promise<Record<string, unknown> | undefined> {
    const node = await helperFor(start);
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
      warnings: Array.isArray(portal.warnings)
        ? portal.warnings.filter((w): w is string => typeof w === "string").slice(0, 8)
        : [],
      checkedAt: now().toISOString(),
    };
    deps.publishEntry(setSetting(deps.db, COMPUTER_USE_LINUX, state));
  }

  async function enabledChanged(on: boolean): Promise<void> {
    // Turning it off starts the helper if needed, so the app structure setting is put back.
    await call("a11y.enable", { enabled: on }, !on);
    await refreshNow();
  }

  async function revoke(): Promise<void> {
    await call("portal.revoke", {}, true);
    await refreshNow();
  }

  return {
    refresh: () => {
      queue(refreshNow);
      return chain;
    },
    helperOnline: () => {
      queue(async () => {
        if (enabled) await call("a11y.enable", { enabled: true });
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
