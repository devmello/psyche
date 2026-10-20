import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join, relative } from "node:path";
import type { RealChromeStatus } from "@psyche/protocol";
import type { GatewayClient, HttpProbe } from "./client.ts";
import { callIfAvailable } from "./commands/util.ts";
import { type ConfigObject, readConfig, validateConfig } from "./config-file.ts";
import type { Ctx } from "./context.ts";
import { toReport } from "./errors.ts";
import { which } from "./exec.ts";
import { type ServiceState, serviceState } from "./supervisor.ts";

/**
 * Everything `doctor` and `security audit` look at, gathered once. Gateway queries that the
 * Gateway does not implement yet are `{ ok: false, reason: "unavailable" }`; rules treat those
 * as "not checked", never as a pass.
 */

export type Query<T> = { ok: true; value: T } | { ok: false; reason: string; message: string };

export interface FileModeIssue {
  path: string;
  mode: string;
  kind: "dir" | "file";
}

export interface Snapshot {
  home: string;
  gatewayUrl: string;
  gatewayHost: string;
  platform: NodeJS.Platform;
  probe: HttpProbe;
  config: { exists: boolean; config: ConfigObject; problems: string[] };
  service: ServiceState | null;
  connection: {
    paired: boolean;
    scopes: readonly string[];
    error?: { code: string; message: string };
  };
  settings: Query<Record<string, unknown>>;
  channels: Query<
    {
      id: string;
      type: string;
      dmPolicy: string;
      ownerIds?: string[];
      groupAllowFrom?: string[];
      requireMention?: boolean;
    }[]
  >;
  grants: Query<
    {
      id: string;
      kind: string;
      scope: string;
      expiresAt?: string | null;
      useCount?: number;
      grantKey?: string;
    }[]
  >;
  devices: Query<
    {
      id: string;
      name: string;
      scopes: string[];
      lastSeenAt?: string | null;
      revokedAt?: string | null;
    }[]
  >;
  nodes: Query<{ id: string; kind: string; status: string; capabilities: { name: string }[] }[]>;
  sandbox: Query<{ backend: string; available: boolean }>;
  vault: Query<{
    state: string;
    slots: string[];
    recoveryConfirmed: boolean;
    autoLockMinutes: number;
    itemCount: number;
  }>;
  apiKeys: Query<{ name: string; bindings: Record<string, string>[] }[]>;
  skills: Query<{ name: string; status: string; trust: string; enabled: boolean }[]>;
  /** The Gateway's real-Chrome mode (I13): the owner's profile on a loopback DevTools port. */
  realChrome: Query<RealChromeStatus>;
  localSandboxBackends: string[];
  disk: { freeBytes: number; totalBytes: number } | null;
  modeIssues: FileModeIssue[];
  homeMode: string | null;
  chromeDebugPort: boolean;
  localModel: boolean;
}

const notConnected = {
  ok: false as const,
  reason: "not_connected",
  message: "not connected to the Gateway",
};

async function q<T>(
  client: GatewayClient | null,
  method: string,
  params: unknown,
  pick: (v: never) => T,
): Promise<Query<T>> {
  if (!client) return notConnected;
  const r = await callIfAvailable<never>(client, method, params);
  return r.ok ? { ok: true, value: pick(r.value) } : r;
}

/** Walks `$PSYCHE_HOME` (up to `limit` entries) for directories not 0700 and files readable by others. */
export function scanModes(
  home: string,
  limit = 20_000,
): { homeMode: string | null; issues: FileModeIssue[] } {
  const issues: FileModeIssue[] = [];
  let homeMode: string | null = null;
  let seen = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (++seen > limit) return;
      const p = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const mode = st.mode & 0o777;
      if (st.isDirectory()) {
        if (mode & 0o077)
          issues.push({ path: relative(home, p), mode: mode.toString(8), kind: "dir" });
        // Sandbox workspaces and browser profiles are huge and owned by their subsystems.
        if (!["sandbox", "browser", "vm", "node_modules"].includes(name)) walk(p);
      } else if (st.isFile() || st.isSocket()) {
        if (mode & 0o077)
          issues.push({ path: relative(home, p), mode: mode.toString(8), kind: "file" });
      }
    }
  };
  try {
    homeMode = (lstatSync(home).mode & 0o777).toString(8);
    walk(home);
  } catch {
    homeMode = null;
  }
  return { homeMode, issues };
}

async function reachable(fetchImpl: typeof fetch, url: string): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(700) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function gatherSnapshot(ctx: Ctx, opts: { connect: boolean }): Promise<Snapshot> {
  const url = ctx.gatewayUrl();
  const probe = await ctx.probe();
  let config: Snapshot["config"];
  try {
    const read = readConfig(ctx.home);
    config = { ...read, problems: validateConfig(read.config) };
  } catch (err) {
    config = { exists: true, config: {}, problems: [toReport(err).message] };
  }
  const service = await serviceState({
    env: ctx.env,
    exec: ctx.deps.exec,
    platform: ctx.deps.platform,
    uid: ctx.deps.uid,
    home: ctx.home,
  }).catch(() => null);

  let client: GatewayClient | null = null;
  let connection: Snapshot["connection"] = { paired: false, scopes: [] };
  if (opts.connect && probe.reachable) {
    const r = await ctx.tryGateway();
    client = r.client;
    connection = client
      ? { paired: true, scopes: client.scopes }
      : { paired: false, scopes: [], error: toReport(r.error) };
  }

  const [settings, channels, grants, devices, nodes, sandbox, vault, apiKeys, skills, realChrome] =
    await Promise.all([
      q(client, "settings.get", {}, (v: { settings: Record<string, unknown> }) => v.settings),
      q(client, "channels.list", {}, (v: { channels: never[] }) => v.channels),
      q(client, "grants.list", {}, (v: { grants: never[] }) => v.grants),
      q(client, "devices.list", {}, (v: { devices: never[] }) => v.devices),
      q(client, "nodes.list", {}, (v: { nodes: never[] }) => v.nodes),
      q(client, "sandbox.status", {}, (v: { backend: string; available: boolean }) => v),
      q(client, "vault.status", {}, (v: { status: never }) => v.status),
      q(client, "vault.list", { kind: "api_key" }, (v: { credentials: never[] }) => v.credentials),
      q(client, "skills.list", {}, (v: { skills: never[] }) => v.skills ?? []),
      q(client, "browser.realChrome.status", {}, (v: RealChromeStatus) => v),
    ]);

  const localSandboxBackends: string[] = [];
  for (const bin of ["container", "docker", "podman"]) {
    if (await which(ctx.deps.exec, bin))
      localSandboxBackends.push(bin === "container" ? "apple-container" : bin);
  }
  let disk: Snapshot["disk"] = null;
  try {
    const s = statfsSync(ctx.home);
    disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    disk = null;
  }
  const { homeMode, issues } = scanModes(ctx.home);
  const [chromeDebugPort, localModel] = await Promise.all([
    reachable(ctx.deps.fetch, "http://127.0.0.1:9222/json/version"),
    reachable(ctx.deps.fetch, "http://127.0.0.1:11434/api/tags"),
  ]);

  return {
    home: ctx.home,
    gatewayUrl: url.origin,
    gatewayHost: url.hostname,
    platform: ctx.deps.platform,
    probe,
    config,
    service,
    connection,
    settings,
    channels,
    grants,
    devices,
    nodes,
    sandbox,
    vault,
    apiKeys,
    skills,
    localSandboxBackends,
    disk,
    modeIssues: issues,
    homeMode,
    chromeDebugPort,
    realChrome,
    localModel,
  };
}

/** Reads a setting stored either flat (`"a.b": v`) or nested (`a: {b: v}`). */
export function setting(s: Snapshot, key: string): unknown {
  if (!s.settings.ok) return undefined;
  const flat = s.settings.value;
  if (Object.hasOwn(flat, key)) return flat[key];
  let cur: unknown = flat;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
