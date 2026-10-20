import { join } from "node:path";
import { getSetting } from "@psyche/db";
import {
  type ContainerLauncherOptions,
  containerLauncher,
  createMcpHost,
  type McpHostOptions,
  type McpRegistration,
  type PsycheMcpHost,
  type PsycheMcpServerConfig,
  registerMcpServerTools,
  type SandboxStdioHost,
  type StdioLauncher,
  srtLauncher,
} from "@psyche/mcp-host";
import { PLACEHOLDER_PATTERN, PsycheError } from "@psyche/protocol";
import type { Gateway } from "../server.ts";
import { mcpGrantRevocation } from "./mcp-grants.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * The MCP host as the Gateway mounts it (architecture §4.9, security §11, K5). The owner's
 * servers live in the admin-only setting `mcp.servers` (an array of server configs) and are
 * added and removed through `settings.set`, the existing protocol: each change reconciles the
 * running servers and their `mcp__<server>__<tool>` registrations.
 *
 * - stdio servers run under `srt` (`srtPath`), or with `container` in their own sandbox
 *   container; without either a non-bundled stdio server is refused (no bare fallback);
 * - grants end when what they were granted for changes: a `tools/list` change revokes the
 *   server's grants bound to another hash and re-registers its tools; removing a server revokes
 *   all of its grants;
 * - env secrets (`{{cred:slug}}` values) ask for their own `credential_fill` approval each.
 */

export const MCP_SERVERS_SETTING = "mcp.servers";

export interface McpSetup {
  /** Absolute path of `srt` (`@anthropic-ai/sandbox-runtime`) for stdio servers. */
  srtPath?: string;
  /** Run stdio servers in their own sandbox container instead of under srt (M3, flagged). */
  container?: SandboxStdioHost & { dispose?(): Promise<void> };
  /**
   * The sandbox egress proxy's allowlist setter (K4): a container server that declares network
   * hosts runs with `network: "proxy"` and reaches only those. Without it such servers are refused.
   */
  egressAllowlist?: ContainerLauncherOptions["egressAllowlist"];
  /** Host overrides (tests: bundled ids and launcher). */
  hostOptions?: Partial<McpHostOptions>;
}

export interface ComposedMcp extends ComposedPart {
  readonly host: PsycheMcpHost;
  /** Settles once every pending reconcile has run (tests, shutdown). */
  idle(): Promise<void>;
}

function launcherFor(services: ComposeServices, setup: McpSetup): StdioLauncher | undefined {
  if (setup.container !== undefined) {
    return containerLauncher({
      sandbox: setup.container,
      ...(setup.egressAllowlist === undefined ? {} : { egressAllowlist: setup.egressAllowlist }),
    });
  }
  if (setup.srtPath !== undefined) {
    return srtLauncher({
      srtPath: setup.srtPath,
      settingsDir: join(services.home, "mcp", "srt"),
      psycheHome: services.home,
    });
  }
  return undefined;
}

/** The configured servers, each with a valid shape; anything else is dropped with a warning. */
function readServers(value: unknown, warn: (msg: string) => void): PsycheMcpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warn("mcp.servers must be an array; ignored");
    return [];
  }
  const out: PsycheMcpServerConfig[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    const c = v as Partial<PsycheMcpServerConfig> | null;
    if (
      c === null ||
      typeof c !== "object" ||
      typeof c.id !== "string" ||
      typeof c.name !== "string" ||
      typeof c.transport !== "object" ||
      c.transport === null ||
      seen.has(c.id)
    ) {
      warn("an mcp.servers entry is malformed or repeated; ignored");
      continue;
    }
    seen.add(c.id);
    out.push({ ...c, trust: c.trust ?? "unknown" } as PsycheMcpServerConfig);
  }
  return out;
}

export function composeMcp(services: ComposeServices, setup: McpSetup = {}): ComposedMcp {
  const warn = (msg: string, fields: Record<string, string> = {}) =>
    services.logger?.log("warn", msg, fields);
  const registrations = new Map<string, McpRegistration>();
  const grants = mcpGrantRevocation(services.rawBroker, (err) =>
    warn("mcp grant revocation failed", { code: PsycheError.from(err).code }),
  );
  const launcher = launcherFor(services, setup);
  const placeholder = new RegExp(`^${PLACEHOLDER_PATTERN.source}$`);
  const host = createMcpHost({
    ...(launcher === undefined ? {} : { launcher }),
    secrets: {
      credentials: services.vault,
      // Each secret gets its own device-only card, answered with presence (security §4.6).
      async approve({ serverId, placeholder: ph, target }) {
        const slug = placeholder.exec(ph)?.[1];
        if (slug === undefined) throw new PsycheError("invalid_params", "not a placeholder");
        const issued = await services.vault.requestFill({
          slug,
          target: target.value,
          executor: "connector",
          requestedBy: { runId: null, taskId: null, threadId: null, agent: `mcp:${serverId}` },
          taint: false,
        });
        const done = await services.broker.awaitDecision(issued.approval.id);
        if (done.status !== "approved") {
          throw new PsycheError("policy_denied", `the secret's approval was ${done.status}`);
        }
        return issued.approval.id;
      },
    },
    ...setup.hostOptions,
    onEvent: (event) => {
      grants.onEvent(event);
      if (event.type === "tools_changed") {
        const reg = registrations.get(event.serverId);
        if (reg !== undefined && reg.hash !== event.hash) {
          reg
            .sync()
            .catch((err) =>
              warn("mcp tools re-registration failed", { code: PsycheError.from(err).code }),
            );
        }
      }
      setup.hostOptions?.onEvent?.(event);
    },
  });
  // Shutdown disconnects without revoking; only an owner's removal ends grants.
  const disconnectAll = () => host.close();
  grants.wrap(host);

  const configs = new Map<string, string>();
  const add = async (config: PsycheMcpServerConfig) => {
    configs.set(config.id, JSON.stringify(config));
    try {
      const info = await host.addServer(config);
      if (info.status !== "connected") {
        warn("mcp server did not connect", { serverId: config.id, status: info.status });
        return;
      }
      registrations.set(config.id, await registerMcpServerTools(host, services.tools, config.id));
    } catch (err) {
      warn("mcp server could not be added", {
        serverId: config.id,
        code: PsycheError.from(err).code,
      });
    }
  };
  const remove = async (serverId: string) => {
    configs.delete(serverId);
    registrations.get(serverId)?.unregister();
    registrations.delete(serverId);
    await host.removeServer(serverId);
  };
  const reconcile = async (value: unknown) => {
    const wanted = readServers(value, (msg) => warn(msg));
    const next = new Map(wanted.map((c) => [c.id, c]));
    for (const id of [...configs.keys()]) {
      const c = next.get(id);
      // A changed config is a different server: its grants end with the old one.
      if (c === undefined || JSON.stringify(c) !== configs.get(id)) await remove(id);
    }
    for (const c of wanted) if (!configs.has(c.id)) await add(c);
  };
  // Changes apply in order, one at a time.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (value: unknown) => {
    queue = queue.then(() => reconcile(value)).catch(() => undefined);
    return queue;
  };

  let unsubscribe: (() => void) | undefined;
  return {
    host,
    idle: () => queue,
    start(gateway: Gateway) {
      void enqueue(getSetting(services.db, MCP_SERVERS_SETTING)?.value);
      unsubscribe = gateway.bus.subscribe(["operator.read"], (frame) => {
        const f = JSON.parse(frame) as {
          event?: string;
          payload?: { entries?: { key: string; value: unknown }[] };
        };
        if (f.event !== "settings.changed") return;
        for (const entry of f.payload?.entries ?? []) {
          if (entry.key === MCP_SERVERS_SETTING) void enqueue(entry.value);
        }
      });
    },
    async stop() {
      unsubscribe?.();
      await queue;
      for (const reg of registrations.values()) reg.unregister();
      registrations.clear();
      await disconnectAll();
      await setup.container?.dispose?.();
    },
  };
}
