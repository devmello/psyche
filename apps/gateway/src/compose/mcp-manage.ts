import { getSetting, setSetting } from "@psyche/db";
import { type McpServerDetails, type PsycheMcpServerConfig, serverTools } from "@psyche/mcp-host";
import {
  type McpServerSecret,
  type McpServerStatus,
  PsycheError,
  parsePlaceholders,
} from "@psyche/protocol";
import type { HandlerDef } from "../context.ts";
import type { ComposeServices } from "./services.ts";

/**
 * Working with a server that is already added (Settings → Connectors → a server's detail):
 *
 * - `mcp.tools` / `mcp.tools.set`: the tools it lists, and which the agent is offered. The owner's
 *   choice is `disabledTools` in the server's own `mcp.servers` entry, so it goes away with the
 *   server; changing it re-registers the tools and leaves the server (and its grants) running.
 * - `mcp.setEnabled`: `enabled: false` in the entry keeps the server configured but not running.
 * - `mcp.secrets` / `mcp.secrets.replace`: env variables and the bearer token by name. Values live
 *   in the vault, bound to `mcp:<id>`; a result never carries one.
 */

export const AUTHORIZATION = "Authorization";

export interface McpManageDeps {
  services: ComposeServices;
  settingKey: string;
  /**
   * Applies a new `mcp.servers` value. With `wait` it settles once the host reconciled it; a
   * start can wait on the owner's approval of a secret, so a call that starts a server does not.
   */
  apply(value: unknown, wait: boolean): Promise<void>;
  /** Stops and starts a running server again (a new secret takes effect at spawn); not awaited. */
  restart(serverId: string): void;
  /** A connected server's tools and scan findings; undefined while it is off or not connected. */
  details(serverId: string): Pick<McpServerDetails, "tools" | "warnings"> | undefined;
  status(config: PsycheMcpServerConfig): McpServerStatus;
}

function readEntries(services: ComposeServices, key: string): PsycheMcpServerConfig[] {
  const v = getSetting(services.db, key)?.value;
  return Array.isArray(v) ? (v as PsycheMcpServerConfig[]) : [];
}

/** The vault slug of a `{{cred:slug}}` value, when it is exactly one placeholder. */
function slugOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const refs = parsePlaceholders(value);
  return refs.length === 1 && refs[0]?.raw === value ? refs[0].slug : undefined;
}

type Secrets = { name: string; value: string | undefined; bearer: boolean }[];

/** The secret slots of a config: every env variable, and the bearer credential of a URL server. */
function slots(c: PsycheMcpServerConfig): Secrets {
  if (c.transport.kind === "stdio") {
    return Object.entries(c.transport.env ?? {}).map(([name, value]) => ({
      name,
      value,
      bearer: false,
    }));
  }
  return c.auth?.kind === "bearer"
    ? [{ name: AUTHORIZATION, value: c.auth.credential, bearer: true }]
    : [];
}

export function mcpManageHandlers(deps: McpManageDeps): Record<string, HandlerDef> {
  const { services } = deps;
  const find = (serverId: string) => {
    const entries = readEntries(services, deps.settingKey);
    const entry = entries.find((c) => c.id === serverId);
    if (entry === undefined) throw new PsycheError("not_found", `no MCP server ${serverId}`);
    return { entries, entry };
  };
  const write = async (value: PsycheMcpServerConfig[], wait = true) => {
    const saved = setSetting(services.db, deps.settingKey, value);
    services.publish("settings.changed", { entries: [saved] });
    await deps.apply(value, wait);
  };
  const audit = (kind: string, serverId: string, data: Record<string, string | boolean>) =>
    services.audit
      .append({ kind, actor: { type: "system" }, subject: { serverId }, data })
      .catch(() => undefined);
  const secretState = (c: PsycheMcpServerConfig, slot: Secrets[number]): McpServerSecret => {
    const slug = slugOf(slot.value);
    if (slug === undefined) {
      return { name: slot.name, storage: "config", isSet: (slot.value ?? "") !== "" };
    }
    const item = services.vault.metaBySlug(slug);
    const bound = item?.bindings.some((b) => "connector" in b && b.connector === `mcp:${c.id}`);
    return { name: slot.name, storage: "vault", isSet: item !== undefined && bound === true };
  };
  const toolsOf = (serverId: string, entry: PsycheMcpServerConfig) => {
    const d = deps.details(serverId);
    return d === undefined ? undefined : serverTools(d, entry.disabledTools ?? []);
  };

  return {
    "mcp.tools": {
      run(_call, params: { serverId: string }) {
        const { entry } = find(params.serverId);
        const tools = toolsOf(params.serverId, entry);
        return { tools: tools ?? [], available: tools !== undefined };
      },
    },
    "mcp.tools.set": {
      async run(_call, params: { serverId: string; tool: string; enabled: boolean }) {
        const { entries, entry } = find(params.serverId);
        const d = deps.details(params.serverId);
        if (d === undefined) {
          throw new PsycheError("unavailable", "the server is off or did not connect", {
            details: { reason: "not_connected" },
          });
        }
        if (!d.tools.some((t) => t.name === params.tool)) {
          throw new PsycheError("not_found", `${params.serverId} has no tool ${params.tool}`);
        }
        const off = new Set(entry.disabledTools ?? []);
        if (params.enabled) off.delete(params.tool);
        else off.add(params.tool);
        const next: PsycheMcpServerConfig = { ...entry };
        if (off.size === 0) delete next.disabledTools;
        else next.disabledTools = [...off].sort();
        await write(entries.map((c) => (c.id === entry.id ? next : c)));
        await audit("mcp.tool_toggled", entry.id, { tool: params.tool, enabled: params.enabled });
        return { tools: toolsOf(params.serverId, next) ?? [] };
      },
    },
    "mcp.setEnabled": {
      async run(_call, params: { serverId: string; enabled: boolean }) {
        const { entries, entry } = find(params.serverId);
        const next: PsycheMcpServerConfig = { ...entry };
        if (params.enabled) delete next.enabled;
        else next.enabled = false;
        if ((entry.enabled !== false) !== params.enabled) {
          // Starting may wait on a secret's approval card: answer now, the status follows.
          await write(
            entries.map((c) => (c.id === entry.id ? next : c)),
            !params.enabled,
          );
          await audit("mcp.server_enabled", entry.id, { enabled: params.enabled });
        }
        return { server: deps.status(next) };
      },
    },
    "mcp.secrets": {
      run(_call, params: { serverId: string }) {
        const { entry } = find(params.serverId);
        return { secrets: slots(entry).map((s) => secretState(entry, s)) };
      },
    },
    "mcp.secrets.replace": {
      async run(_call, params: { serverId: string; name: string; value: string }) {
        const { entries, entry } = find(params.serverId);
        const slot = slots(entry).find((s) => s.name === params.name);
        if (slot === undefined) {
          throw new PsycheError("not_found", `${params.serverId} has no secret ${params.name}`);
        }
        const target = `mcp:${entry.id}`;
        const slug = slugOf(slot.value);
        const item = slug === undefined ? undefined : services.vault.metaBySlug(slug);
        // Only an item made for this server is overwritten; any other slug gets a new item.
        const ours =
          item !== undefined &&
          item.ownerConnectorId === null &&
          item.bindings.some((b) => "connector" in b && b.connector === target);
        let placeholder = slot.value;
        if (ours && item !== undefined) {
          await services.vault.update(item.id, { secret: { token: params.value } });
        } else {
          const fresh = freshSlug(services, entry.id, slot.name);
          await services.vault.add({
            kind: "api_key",
            name: `${entry.name} ${slot.name}`.slice(0, 200),
            slug: fresh,
            bindings: [{ connector: target }],
            secret: {
              token: params.value,
              ...(slot.bearer ? { headerName: AUTHORIZATION, headerPrefix: "Bearer " } : {}),
            },
          });
          placeholder = `{{cred:${fresh}}}`;
        }
        if (placeholder !== slot.value) {
          // Moves a plain value (or a foreign slug) to the new vault item: a changed config, so
          // the reconcile restarts the server.
          const next = withSecret(entry, slot, placeholder as string);
          await write(
            entries.map((c) => (c.id === entry.id ? next : c)),
            false,
          );
        } else {
          deps.restart(entry.id);
        }
        await audit("mcp.secret_replaced", entry.id, { name: slot.name });
        const updated = find(entry.id).entry;
        const state = slots(updated).find((s) => s.name === slot.name);
        return { secret: secretState(updated, state ?? slot) };
      },
    },
  };
}

function withSecret(
  entry: PsycheMcpServerConfig,
  slot: Secrets[number],
  placeholder: string,
): PsycheMcpServerConfig {
  if (entry.transport.kind === "stdio") {
    return {
      ...entry,
      transport: { ...entry.transport, env: { ...entry.transport.env, [slot.name]: placeholder } },
    };
  }
  return { ...entry, auth: { kind: "bearer", credential: placeholder } };
}

/** `mcp-<server>-<name>` as a vault slug, made unique. */
function freshSlug(services: ComposeServices, serverId: string, name: string): string {
  const base = `mcp-${serverId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    .replace(/-+$/g, "")
    .slice(0, 56);
  for (let i = 0; ; i++) {
    const slug = i === 0 ? base : `${base}-${i}`;
    if (services.vault.metaBySlug(slug) === undefined) return slug;
  }
}
