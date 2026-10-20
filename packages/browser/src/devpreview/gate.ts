import { PsycheError } from "@psyche/protocol";
import { canonicalizeUrl, classifyHost } from "../origin/canonical.ts";

/**
 * Which loopback servers a task may preview (feature I12; security §3.10). Loopback is not the
 * web: `localhost:<port>` can be the owner's Vite app, or their password manager's local API.
 * So a dev preview opens only a server the owner's own setup names:
 *
 * - a server Psyche started this session from an rw-granted folder (the sandbox / exec layer
 *   registers it with `started`);
 * - a port declared in the project's launch config (`launchConfig`);
 * - a port the owner allowlisted (`ownerPorts`, Settings → Browser / `PSYCHE_DEV_PREVIEW_PORTS`).
 *
 * The verdict says which source matched; the broker still asks (`new_origin`) before the
 * first open, and the dev-preview session's policy is pinned to that port. This gate is a
 * pre-filter: the broker's own localhost rule (`@psyche/permissions` `LocalProjectVerifier`, fed
 * by `systemLoopbackProbes`) additionally requires the listener to descend from a process
 * Psyche started (`started({pid})`), so a launch-config or allowlisted port the owner started
 * by hand is refused there.
 */
export type DevServerSource = "started" | "launch_config" | "owner";

export interface DevServer {
  port: number;
  source: DevServerSource;
  /** Project folder the server runs from, when known. */
  cwd?: string;
  /** Launch-config name or the command, for the approval card. */
  name?: string;
  /** A server started for one task is previewable by that task only. */
  taskId?: string;
  /** The process Psyche spawned for it; the broker's localhost rule walks up to this root. */
  pid?: number;
}

export type DevPreviewVerdict =
  | { ok: true; origin: string; port: number; server: DevServer }
  | {
      ok: false;
      reason: "invalid_url" | "not_loopback" | "unknown_dev_server" | "other_task" | "psyche_port";
      message: string;
    };

export interface DevPreviewGate {
  check(url: string, context: { taskId?: string }): Promise<DevPreviewVerdict>;
  /** Everything the task may preview, for the approval card and the tool's error message. */
  list(context: { taskId?: string }): Promise<DevServer[]>;
}

export interface LaunchConfigEntry {
  name: string;
  port: number;
  cwd?: string;
}

export interface DevServerRegistryOptions {
  ownerPorts?: number[];
  /**
   * Psyche's own listening ports (Gateway, OAuth receivers, real-Chrome CDP): refused even when
   * the owner allowlists them or a launch config names them.
   */
  reservedPorts?: () => Promise<readonly number[]> | readonly number[];
  /** The owner's launch configs, read on each check so edits apply at once. */
  launchConfig?: () => Promise<LaunchConfigEntry[]> | LaunchConfigEntry[];
}

export class DevServerRegistry implements DevPreviewGate {
  #started = new Map<number, DevServer>();
  #o: DevServerRegistryOptions;

  constructor(options: DevServerRegistryOptions = {}) {
    this.#o = options;
  }

  /**
   * Psyche started a server (sandbox `exec`, a launch config, the terminal pane). Pass the PID
   * Psyche spawned: the broker's localhost rule (security §3.10) only accepts a listener that
   * descends from it.
   */
  started(server: {
    port: number;
    cwd?: string;
    name?: string;
    taskId?: string;
    pid?: number;
  }): void {
    if (server.pid !== undefined && (server.pid === process.pid || server.pid <= 1)) {
      // The Gateway itself is never a dev server's root: every listener it owns would pass.
      throw new PsycheError(
        "invalid_params",
        "a dev server's pid must be a process Psyche spawned",
      );
    }
    const entry: DevServer = { port: server.port, source: "started" };
    if (server.pid !== undefined) entry.pid = server.pid;
    if (server.cwd !== undefined) entry.cwd = server.cwd;
    if (server.name !== undefined) entry.name = server.name;
    if (server.taskId !== undefined) entry.taskId = server.taskId;
    this.#started.set(server.port, entry);
  }

  /** The server exited. */
  stopped(port: number): void {
    this.#started.delete(port);
  }

  /** Root PIDs of servers Psyche started this session (for `systemLoopbackProbes`). */
  spawnedPids(): number[] {
    return [...this.#started.values()].flatMap((s) => (s.pid === undefined ? [] : [s.pid]));
  }

  async list(context: { taskId?: string } = {}): Promise<DevServer[]> {
    const out: DevServer[] = [];
    for (const s of this.#started.values()) {
      if (s.taskId !== undefined && s.taskId !== context.taskId) continue;
      out.push(s);
    }
    for (const e of (await this.#o.launchConfig?.()) ?? []) {
      const entry: DevServer = { port: e.port, source: "launch_config", name: e.name };
      if (e.cwd !== undefined) entry.cwd = e.cwd;
      out.push(entry);
    }
    for (const port of this.#o.ownerPorts ?? []) out.push({ port, source: "owner" });
    return out;
  }

  async check(url: string, context: { taskId?: string } = {}): Promise<DevPreviewVerdict> {
    let u: ReturnType<typeof canonicalizeUrl>;
    try {
      u = canonicalizeUrl(url);
    } catch (err) {
      return {
        ok: false,
        reason: "invalid_url",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    // §3.10: exactly localhost, 127.0.0.1, [::1] or a `.localhost` name. Never a LAN address.
    if (!classifyHost(u.host, u.hostKind).loopback) {
      return {
        ok: false,
        reason: "not_loopback",
        message: `${u.origin} is not a local dev server; use browser.navigate for the web`,
      };
    }
    const reserved = (await this.#o.reservedPorts?.()) ?? [];
    if (reserved.includes(u.port)) {
      return {
        ok: false,
        reason: "psyche_port",
        message: `port ${u.port} is one of Psyche's own listeners, not a dev server`,
      };
    }
    const started = this.#started.get(u.port);
    if (started?.taskId !== undefined && started.taskId !== context.taskId) {
      return {
        ok: false,
        reason: "other_task",
        message: `port ${u.port} belongs to another task's dev server`,
      };
    }
    const server = (await this.list(context)).find((s) => s.port === u.port);
    if (server === undefined) {
      return {
        ok: false,
        reason: "unknown_dev_server",
        message: `port ${u.port} is not a dev server Psyche started, a launch config declares or the owner allowlisted`,
      };
    }
    return { ok: true, origin: u.origin, port: u.port, server };
  }
}
