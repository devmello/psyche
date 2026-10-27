import { createHash, randomUUID } from "node:crypto";
import { getSetting, setSetting } from "@psyche/db";
import {
  createMcpHost,
  type McpHostOptions,
  type PsycheMcpServerConfig,
  type StdioLauncher,
  type ToolWarning,
} from "@psyche/mcp-host";
import { bindingFor } from "@psyche/permissions";
import {
  type McpProbedTool,
  type McpProposal,
  type McpServerInput,
  type McpServerStatus,
  mcpTrustFor,
  PsycheError,
} from "@psyche/protocol";
import type { HandlerDef } from "../context.ts";
import type { ComposeServices } from "./services.ts";

/**
 * Adding an MCP server from Settings → MCP (#529): probe → trust card → add.
 *
 * - `mcp.probe` starts the server in a throwaway host with the same launcher as the real one
 *   (srt, or its own container; a stdio server without a launcher is refused, never run bare),
 *   reads its `tools/list` and scan warnings, stops it, and opens a device-only `skill_install`
 *   card (`details.kind: "mcp_server"`) listing the tools, the network reach and the isolation.
 *   The probe host registers nothing: no tool reaches the agent before the card is approved.
 * - `mcp.add` consumes that approval (bound to the config and the probed `tools/list` hash) and
 *   appends the server to `mcp.servers`; the running host then starts it as usual. A server whose
 *   listing differs from what the owner approved is taken out again (`conflict`).
 * - `mcp.remove` drops it from `mcp.servers`; its tools unregister and its grants are revoked.
 */

export const MCP_PROPOSAL_TTL_MS = 30 * 60_000;
const BLOCKING = new Set<ToolWarning["code"]>([
  "instruction_like",
  "hidden_markup",
  "invisible_characters",
]);

export interface McpAddDeps {
  services: ComposeServices;
  settingKey: string;
  /** The launcher the real host uses; undefined = none (stdio servers refused). */
  launcher: StdioLauncher | undefined;
  /** Shared with the real host: env secrets ask for their own approval. */
  secrets: McpHostOptions["secrets"];
  hostOptions?: Partial<McpHostOptions>;
  /** Applies a new `mcp.servers` value and settles once the host reconciled it. */
  apply(value: unknown): Promise<void>;
  /** The running server's status, after `apply`. */
  status(serverId: string): McpServerStatus | undefined;
  /** The running server's pinned `tools/list` hash, when it connected. */
  toolsHash(serverId: string): string | undefined;
}

interface Staged {
  proposal: McpProposal;
  config: PsycheMcpServerConfig;
  bindingHash: string;
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** Sorted-key JSON, so the hash does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The `mcp.servers` entry for an owner's input. Trust follows where the server comes from
 * (`mcpTrustFor`: an official package or vendor endpoint is `verified`, anything else `unknown`);
 * never `bundled`.
 */
export function serverConfig(input: McpServerInput): PsycheMcpServerConfig {
  const t = input.transport;
  if (t.kind === "stdio") {
    return {
      id: input.id,
      name: input.name,
      trust: mcpTrustFor({ kind: "stdio", command: t.command }),
      transport: {
        kind: "stdio",
        command: [...t.command],
        ...(t.env ? { env: { ...t.env } } : {}),
      },
      sandbox: { allowedDomains: [...(input.allowedDomains ?? [])] },
    };
  }
  return {
    id: input.id,
    name: input.name,
    trust: mcpTrustFor({ kind: "http", url: t.url }),
    transport: { kind: "http", url: t.url },
    ...(t.auth === undefined ? {} : { auth: t.auth }),
  };
}

function readServers(services: ComposeServices, key: string): PsycheMcpServerConfig[] {
  const v = getSetting(services.db, key)?.value;
  return Array.isArray(v) ? (v as PsycheMcpServerConfig[]) : [];
}

function sideEffectOf(annotations: unknown): McpProbedTool["sideEffect"] {
  const a = (annotations ?? {}) as { readOnlyHint?: unknown; destructiveHint?: unknown };
  if (a.readOnlyHint === true) return "read";
  if (a.destructiveHint === true) return "destructive";
  return "write";
}

export function mcpAddHandlers(deps: McpAddDeps): Record<string, HandlerDef> {
  const { services } = deps;
  const staged = new Map<string, Staged>();
  const now = () => services.clock.now();
  const sweep = () => {
    for (const [id, s] of staged) if (s.proposal.expiresAt <= now()) staged.delete(id);
  };

  const probe = async (input: McpServerInput): Promise<Omit<McpProposal, "id" | "expiresAt">> => {
    const config = serverConfig(input);
    // The host override (tests) wins, as it does for the real host.
    const launcher = deps.hostOptions?.launcher ?? deps.launcher;
    if (
      config.transport.kind === "stdio" &&
      (launcher === undefined ||
        launcher.isolation === "none" ||
        (launcher.ready !== undefined && !(await launcher.ready())))
    ) {
      throw new PsycheError(
        "unavailable",
        "This Gateway has no sandbox for command servers (srt or containers); only URL servers can be added",
        { details: { reason: "no_launcher" } },
      );
    }
    // Same launcher and secrets as the real host; nothing is registered, no events reach it.
    const { onEvent: _ignored, ...hostOptions } = deps.hostOptions ?? {};
    const host = createMcpHost({
      ...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
      ...hostOptions,
      ...(launcher === undefined ? {} : { launcher }),
    });
    const probeId = `${config.id}-probe-${randomUUID().slice(0, 8)}`;
    try {
      const info = await host.addServer({ ...config, id: probeId });
      const d = host.describe(probeId);
      if (info.status !== "connected" || d.toolsListHash === undefined) {
        throw new PsycheError("unavailable", "The server did not start", {
          details: {
            reason: "probe_failed",
            // Server-authored and redacted by the host: shown as data.
            diagnostics: (d.error ?? d.stderrTail ?? "").slice(-2_000),
          },
        });
      }
      const warnings = d.warnings;
      const tools: McpProbedTool[] = d.tools.map((t) => {
        const own = warnings.filter((w) => w.tool === t.name);
        return {
          name: t.name,
          description: (t.description ?? "").slice(0, 2_000),
          sideEffect: sideEffectOf(t.annotations),
          warnings: own.map((w) => ({ code: w.code, detail: w.detail })),
          blocked: own.some((w) => BLOCKING.has(w.code)),
        };
      });
      const http = config.transport.kind === "http";
      const hosts = http
        ? [new URL((config.transport as { url: string }).url).host]
        : [...(config.sandbox?.allowedDomains ?? [])];
      const diagnostics = d.stderrTail.trim();
      return {
        server: input,
        tools,
        toolsListHash: d.toolsListHash,
        network: { reaches: hosts.length > 0, hosts },
        isolation: http ? "remote" : launcher?.isolation === "container" ? "container" : "srt",
        ...(diagnostics === "" ? {} : { diagnostics: diagnostics.slice(-2_000) }),
      };
    } finally {
      await host.removeServer(probeId).catch(() => undefined);
      await host.close().catch(() => undefined);
    }
  };

  const binding = (config: PsycheMcpServerConfig, p: Omit<McpProposal, "id" | "expiresAt">) => {
    const permissions = new Set<string>();
    if (p.tools.some((t) => t.sideEffect !== "read")) permissions.add("mcp_tool_write");
    if (p.network.reaches) permissions.add("network");
    if (/\{\{cred:/.test(JSON.stringify(config))) permissions.add("credential_fill");
    return bindingFor("skill_install", {
      name: `mcp:${config.id}`,
      scope: "home",
      source: { kind: "path", path: `mcp/${config.id}.json` },
      treeHash: sha(canonical({ config, toolsListHash: p.toolsListHash })),
      tools: p.tools.map((t) => t.name),
      permissions: [...permissions].sort(),
      prompts: [],
    });
  };

  return {
    "mcp.probe": {
      async run(_call, params: { server: McpServerInput }) {
        sweep();
        const input = params.server;
        if (readServers(services, deps.settingKey).some((c) => c.id === input.id)) {
          throw new PsycheError("conflict", `an MCP server with id ${input.id} exists`);
        }
        const found = await probe(input);
        const config = serverConfig(input);
        const b = binding(config, found);
        const id = `mcpp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        const proposal: McpProposal = { id, ...found, expiresAt: now() + MCP_PROPOSAL_TTL_MS };
        const t = config.transport;
        const issued = await services.broker.requestApproval({
          kind: "skill_install",
          summary: `Add MCP server "${input.name}" (${found.tools.length} tools${found.network.reaches ? `, reaches ${found.network.hosts.join(", ").slice(0, 120)}` : ", no network"})`,
          details: {
            kind: "mcp_server",
            id: input.id,
            name: input.name,
            ...(t.kind === "stdio" ? { command: t.command.join(" ") } : { url: t.url }),
            isolation: found.isolation,
            network: found.network.reaches ? found.network.hosts : [],
            // What the agent could do: every tool, its tier, and whether it stays off.
            tools: found.tools.map(
              (x) =>
                `${x.sideEffect} ${x.name}${x.blocked ? " (off: suspicious description)" : ""}`,
            ),
            warnings: found.tools.reduce((n, x) => n + x.warnings.length, 0),
            toolsListHash: found.toolsListHash,
          },
          bindingHash: b.bindingHash,
          grantKey: b.grantKey,
          requestedBy: { runId: null, taskId: null, threadId: null },
          sideEffect: "destructive",
          surfaces: ["desktop"],
          scopesOffered: ["once"],
          taint: false,
        });
        services.publish("approval.created", { approval: issued.approval });
        staged.set(id, { proposal, config, bindingHash: b.bindingHash });
        return { proposal, approval: issued.approval };
      },
    },
    "mcp.add": {
      async run(_call, params: { proposalId: string; approvalId: string }) {
        sweep();
        const s = staged.get(params.proposalId);
        if (s === undefined) {
          throw new PsycheError("approval_expired", "the probe expired; check the server again");
        }
        const approval = await services.rawBroker.get(params.approvalId);
        if (
          approval === undefined ||
          approval.kind !== "skill_install" ||
          (approval.details as { kind?: unknown }).kind !== "mcp_server"
        ) {
          throw new PsycheError(
            "approval_required",
            "adding an MCP server needs its approved trust card",
          );
        }
        const v = await services.rawBroker.verifyBinding(params.approvalId, s.bindingHash);
        if (!v.ok) {
          throw new PsycheError(
            v.reason === "binding_mismatch" ? "binding_mismatch" : "approval_required",
            `trust card not usable: ${v.reason}`,
          );
        }
        staged.delete(params.proposalId);
        const id = s.config.id;
        const current = readServers(services, deps.settingKey);
        if (current.some((c) => c.id === id)) {
          throw new PsycheError("conflict", `an MCP server with id ${id} exists`);
        }
        const write = async (value: PsycheMcpServerConfig[]) => {
          const entry = setSetting(services.db, deps.settingKey, value);
          services.publish("settings.changed", { entries: [entry] });
          await deps.apply(value);
        };
        await write([...current, s.config]);
        const hash = deps.toolsHash(id);
        if (hash !== undefined && hash !== s.proposal.toolsListHash) {
          // The server now lists other tools than the card showed: take it out again.
          await write(readServers(services, deps.settingKey).filter((c) => c.id !== id));
          throw new PsycheError(
            "conflict",
            "the server's tools changed since you approved them; check it again",
          );
        }
        await services.broker
          .recordReceipt({
            kind: "mcp_server_add",
            outcome: "ok",
            summary: `Added MCP server "${s.config.name}" (${s.proposal.tools.length} tools)`,
            approvalId: params.approvalId,
            externalRefs: { serverId: id, toolsListHash: s.proposal.toolsListHash },
          })
          .catch(() => undefined);
        const status = deps.status(id);
        if (status === undefined) throw new PsycheError("internal", "the server was not added");
        return { server: status };
      },
    },
    "mcp.remove": {
      async run(_call, params: { serverId: string }) {
        const current = readServers(services, deps.settingKey);
        if (!current.some((c) => c.id === params.serverId)) {
          throw new PsycheError("not_found", `no MCP server ${params.serverId}`);
        }
        const next = current.filter((c) => c.id !== params.serverId);
        const entry = setSetting(services.db, deps.settingKey, next);
        services.publish("settings.changed", { entries: [entry] });
        await deps.apply(next);
        return { ok: true as const };
      },
    },
  };
}
