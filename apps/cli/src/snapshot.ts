import { existsSync, lstatSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { join, relative } from "node:path";
import type { BackupInfo, McpServerStatus, RealChromeStatus } from "@psyche/protocol";
import type { GatewayClient, HttpProbe } from "./client.ts";
import { callIfAvailable } from "./commands/util.ts";
import { type ConfigObject, readConfig, validateConfig } from "./config-file.ts";
import type { Ctx } from "./context.ts";
import { toReport } from "./errors.ts";
import { which } from "./exec.ts";
import { launchAgentPath, type ServiceState, serviceState } from "./supervisor.ts";

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

/** `$PSYCHE_HOME/run/updater.json`, written by the desktop after each update check. */
export interface UpdaterState {
  state: "disabled" | "no_keys" | "none" | "refused" | "started";
  appVersion?: string;
  keys?: number;
  checkedAt?: string;
  code?: string;
  reason?: string;
}

export function readUpdaterState(home: string): Query<UpdaterState> {
  try {
    const v = JSON.parse(readFileSync(join(home, "run", "updater.json"), "utf8")) as UpdaterState;
    if (typeof v?.state !== "string") throw new Error("no state");
    return { ok: true, value: v };
  } catch {
    return {
      ok: false,
      reason: "unavailable",
      message: "no run/updater.json (the desktop app has not checked for updates here)",
    };
  }
}

/** The installed LaunchAgent's program. A DMG install points it into Psyche.app. */
export interface LaunchAgentInfo {
  file: string;
  /** `ProgramArguments[0]`, or null when the plist has none. */
  program: string | null;
  programExists: boolean;
  /** The Psyche.app that holds `program` (`…/Psyche.app/Contents/Resources/psyched/psyched`). */
  app: string | null;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** The program of a LaunchAgent plist (XML, as `psyche start` and the desktop write it). */
export function launchAgentProgram(plist: string): string | null {
  const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist);
  if (!m?.[1]) return null;
  return m[1].replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e] ?? e);
}

/** The Psyche.app a bundled psyched lives in, or null for any other program. */
export function appOfProgram(program: string): string | null {
  return /^(.*\.app)\/Contents\/Resources\/psyched\/psyched$/.exec(program)?.[1] ?? null;
}

export function readLaunchAgent(file: string): LaunchAgentInfo | null {
  let plist: string;
  try {
    plist = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const program = launchAgentProgram(plist);
  return {
    file,
    program,
    programExists: program !== null && existsSync(program),
    app: program === null ? null : appOfProgram(program),
  };
}

/** The helper's `permissions.status` capability (S14 packaging contract), as doctor reads it. */
export interface HelperPermissions {
  permissions: { permission: string; status: string; title?: string; settingsURL?: string }[];
  next: string | null;
  bundled?: boolean;
  bundle?: {
    path?: string;
    version?: string;
    signing?: "developer_id" | "development" | "adhoc" | "unsigned";
    teamId?: string;
    insideApp?: boolean;
  };
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
      pairedAt?: string | null;
      revokedAt?: string | null;
    }[]
  >;
  nodes: Query<{ id: string; kind: string; status: string; capabilities: { name: string }[] }[]>;
  sandbox: Query<{ backend: string; available: boolean; egress?: boolean }>;
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
  /** How the Gateway isolates MCP servers (`mcp.status`). */
  mcp: Query<{ launcher: "srt" | "container" | "none"; servers: McpServerStatus[] }>;
  /** Archives in $PSYCHE_HOME/backups (`backup.list`). */
  backups: Query<BackupInfo[]>;
  /** The desktop's last update check, `$PSYCHE_HOME/run/updater.json` (security §11). */
  updater: Query<UpdaterState>;
  /** macOS: the installed LaunchAgent (null when there is none). */
  launchAgent?: LaunchAgentInfo | null;
  /** macOS: Psyche.app, from the LaunchAgent's program, else /Applications or ~/Applications. */
  app?: string | null;
  /** macOS: the helper's `permissions.status` (read only, no prompts). */
  helperPermissions?: Query<HelperPermissions>;
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

  const [
    settings,
    channels,
    grants,
    devices,
    nodes,
    sandbox,
    vault,
    apiKeys,
    skills,
    realChrome,
    mcp,
    backups,
  ] = await Promise.all([
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
    q(
      client,
      "mcp.status",
      {},
      (v: { launcher: "srt" | "container" | "none"; servers: McpServerStatus[] }) => v,
    ),
    q(client, "backup.list", {}, (v: { backups: BackupInfo[] }) => v.backups),
  ]);

  // The helper reports what macOS has granted it (a read capability; never prompts).
  let helperPermissions: Query<HelperPermissions> | undefined;
  if (ctx.deps.platform === "darwin" && client && nodes.ok) {
    const list: { id: string; kind: string; status: string }[] = nodes.value;
    const helper = list.find((n) => n.kind === "mac-helper" && n.status === "online");
    if (helper) {
      const r = await callIfAvailable<{
        ok: boolean;
        result?: HelperPermissions;
        error?: { message?: string };
      }>(client, "nodes.invoke", {
        nodeId: helper.id,
        capability: "permissions.status",
        params: {},
      });
      helperPermissions = !r.ok
        ? r
        : r.value.ok && r.value.result
          ? { ok: true, value: r.value.result }
          : {
              ok: false,
              reason: "error",
              message: `permissions.status: ${r.value.error?.message ?? "no result"}`,
            };
    }
  }
  let launchAgent: LaunchAgentInfo | null = null;
  let app: string | null = null;
  if (ctx.deps.platform === "darwin") {
    launchAgent = readLaunchAgent(service?.file ?? launchAgentPath(ctx.env));
    app =
      launchAgent?.app ??
      [
        join("/Applications", "Psyche.app"),
        join(ctx.env.HOME ?? "", "Applications", "Psyche.app"),
      ].find((p) => existsSync(p)) ??
      null;
  }

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
    mcp,
    backups,
    updater: readUpdaterState(ctx.home),
    localModel,
    ...(ctx.deps.platform === "darwin" ? { launchAgent, app } : {}),
    ...(helperPermissions === undefined ? {} : { helperPermissions }),
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
