import { createHash } from "node:crypto";
import { getSetting, setSetting } from "@psyche/db";
import type { PsycheMcpServerConfig } from "@psyche/mcp-host";
import {
  type McpServerChanges,
  type McpServerConfigView,
  type McpServerInput,
  type McpServerStatus,
  mcpTrustFor,
  PsycheError,
} from "@psyche/protocol";
import type { HandlerDef } from "../context.ts";
import {
  looksSecretName,
  REDACTED,
  redactText,
  redactUrl,
  scrubError,
  urlHoldsMarker,
} from "../redact.ts";
import { canonical, inputOfAny, type McpAdder } from "./mcp-add.ts";
import type { ComposeServices } from "./services.ts";

export { REDACTED, redactText, redactUrl, urlHoldsMarker };

/**
 * Editing a server in place, and testing one that is already approved (Settings → Connectors → a
 * server → Edit / Test connection).
 *
 * - `mcp.update {id, changes}`: the Gateway applies `changes` to the stored config and compares
 *   the result with it; the caller never says whether a change is cosmetic.
 *   - Only the display name differs: written at once (the server keeps running; no restart).
 *   - Anything that changes what runs or where it connects (argv, URL, auth, allowed domains, env
 *     names or secret placeholders): the same probe → device-only trust card as `mcp.probe`, with
 *     the old and the new config on it. Nothing is written and the old server keeps running until
 *     `mcp.add` consumes the approved card; then the existing reconcile restarts it with the new
 *     config. The card binds the new config, the probed `tools/list` and a hash of the config it
 *     replaces, so an approval cannot be spent on another edit or after the server changed.
 * - `mcp.test {id}`: asks the running server for its tools, or, when it is on but not connected,
 *   starts its stored config once in the sandbox. Takes no config, changes none, raises no card.
 */

export interface McpEditDeps {
  services: ComposeServices;
  settingKey: string;
  adder: McpAdder;
  /** Applies a new `mcp.servers` value without waiting for a start. */
  apply(value: unknown): Promise<void>;
  status(config: PsycheMcpServerConfig): McpServerStatus;
  /** Asks a connected server for its tool names; undefined when it is not connected here. */
  ping(serverId: string): Promise<string[] | undefined>;
}

const readEntries = (services: ComposeServices, key: string): PsycheMcpServerConfig[] => {
  const v = getSetting(services.db, key)?.value;
  return Array.isArray(v) ? (v as PsycheMcpServerConfig[]) : [];
};

const sha = (v: unknown) => createHash("sha256").update(canonical(v), "utf8").digest("hex");

/** Psyche-made, shared and built-in servers: their code or command was approved as a whole. */
export const mcpEditable = (c: PsycheMcpServerConfig): boolean =>
  c.madeBy === undefined && c.bundle === undefined && c.trust !== "bundled";

/** Everything that decides what runs and where it connects. A change of it needs a trust card. */
export function runIdentity(c: PsycheMcpServerConfig): unknown {
  return {
    transport: c.transport,
    sandbox: c.sandbox ?? null,
    auth: c.auth ?? null,
    cwd: c.cwd ?? null,
    trust: c.trust,
  };
}

/** The stored config with `changes` on top; throws `invalid_params` for a field the kind lacks. */
export function applyChanges(
  prev: PsycheMcpServerConfig,
  changes: McpServerChanges,
): PsycheMcpServerConfig {
  const next = structuredClone(prev);
  if (changes.name !== undefined) next.name = changes.name;
  const t = next.transport;
  const wrong = (field: string) =>
    new PsycheError(
      "invalid_params",
      `${field} does not apply to a ${t.kind === "stdio" ? "command" : "URL"} server`,
    );
  if (t.kind === "stdio") {
    if (changes.url !== undefined) throw wrong("url");
    if (changes.auth !== undefined) throw wrong("auth");
    if (changes.command !== undefined) t.command = [...changes.command];
    if (changes.env !== undefined) {
      const env = { ...(t.env ?? {}) };
      for (const [k, v] of Object.entries(changes.env)) {
        if (v === null) delete env[k];
        else env[k] = v;
      }
      if (Object.keys(env).length === 0) delete t.env;
      else t.env = env;
    }
    if (changes.allowedDomains !== undefined) {
      next.sandbox = { ...(next.sandbox ?? {}), allowedDomains: [...changes.allowedDomains] };
    }
    next.trust = mcpTrustFor({ kind: "stdio", command: t.command });
  } else {
    if (changes.command !== undefined) throw wrong("command");
    if (changes.env !== undefined) throw wrong("env");
    if (changes.allowedDomains !== undefined) throw wrong("allowedDomains");
    if (changes.url !== undefined) t.url = changes.url;
    if (changes.auth !== undefined) next.auth = changes.auth;
    next.trust = mcpTrustFor({ kind: "http", url: t.url });
  }
  // The tier follows what runs: when none of it changed, the stored tier stays (a built-in or
  // shared server renamed keeps its tier, whatever its command looks like).
  const shape = (c: PsycheMcpServerConfig) =>
    canonical({ t: c.transport, s: c.sandbox ?? null, a: c.auth ?? null, w: c.cwd ?? null });
  if (shape(prev) === shape(next)) next.trust = prev.trust;
  return next;
}

/** `McpServerInput` with nothing a caller did not send: env values and URL secrets hidden. */
function redactedInput(input: McpServerInput): McpServerInput {
  const t = input.transport;
  if (t.kind === "http") return { ...input, transport: { ...t, url: redactUrl(t.url) } };
  if (t.env === undefined) return input;
  const env = Object.fromEntries(
    Object.entries(t.env).map(([k, v]) => [k, /^\{\{cred:[^}]+\}\}$/.test(v) ? v : ""]),
  );
  return { ...input, transport: { ...t, env } };
}

/** What differs, by name only: never a value (a plain env value can hold a token). */
export function describeChange(prev: PsycheMcpServerConfig, next: PsycheMcpServerConfig) {
  const a = prev.transport;
  const b = next.transport;
  const out: Record<string, unknown> = {};
  const fields: string[] = [];
  if (a.kind === "stdio" && b.kind === "stdio") {
    if (canonical(a.command) !== canonical(b.command)) {
      fields.push("command");
      out.oldCommand = a.command.join(" ");
      out.newCommand = b.command.join(" ");
    }
    const was = a.env ?? {};
    const now = b.env ?? {};
    const added = Object.keys(now).filter((k) => !(k in was));
    const removed = Object.keys(was).filter((k) => !(k in now));
    const changed = Object.keys(now).filter((k) => k in was && was[k] !== now[k]);
    if (added.length > 0) out.envAdded = added;
    if (removed.length > 0) out.envRemoved = removed;
    if (changed.length > 0) out.envChanged = changed;
    if (added.length + removed.length + changed.length > 0) fields.push("env");
    const d0 = prev.sandbox?.allowedDomains ?? [];
    const d1 = next.sandbox?.allowedDomains ?? [];
    if (canonical(d0) !== canonical(d1)) {
      fields.push("domains");
      out.oldDomains = d0;
      out.newDomains = d1;
    }
  } else if (a.kind === "http" && b.kind === "http") {
    if (a.url !== b.url) {
      fields.push("url");
      out.oldUrl = redactUrl(a.url);
      out.newUrl = redactUrl(b.url);
      // What the redacted rows cannot show: which query parameters changed, and whether the
      // user info did. Names only.
      try {
        const x = new URL(a.url);
        const y = new URL(b.url);
        const keys = new Set([...x.searchParams.keys(), ...y.searchParams.keys()]);
        // A key that is itself a secret (no value, a token-like name) is never listed.
        const changed = [...keys].filter(
          (k) =>
            !looksSecretName(k) &&
            !x.searchParams.getAll(k).includes("") &&
            !y.searchParams.getAll(k).includes("") &&
            JSON.stringify(x.searchParams.getAll(k)) !== JSON.stringify(y.searchParams.getAll(k)),
        );
        if (changed.length > 0) out.queryChanged = changed;
        if (x.username !== y.username || x.password !== y.password) out.userinfoChanged = true;
      } catch {
        // an address that does not parse shows only the redacted rows
      }
    }
    if (canonical(prev.auth ?? null) !== canonical(next.auth ?? null)) {
      fields.push("auth");
      out.oldAuth = prev.auth?.kind ?? "default";
      out.newAuth = next.auth?.kind ?? "default";
    }
  }
  if (fields.length === 0) fields.push("config");
  return { fields, out };
}

export function configView(c: PsycheMcpServerConfig): McpServerConfigView {
  const t = c.transport;
  return {
    id: c.id,
    name: c.name,
    kind: t.kind === "stdio" ? "command" : "url",
    ...(t.kind === "stdio" ? { command: [...t.command] } : { url: redactUrl(t.url) }),
    allowedDomains: [...(c.sandbox?.allowedDomains ?? [])],
    envNames: t.kind === "stdio" ? Object.keys(t.env ?? {}) : [],
    ...(t.kind === "http" ? { auth: c.auth?.kind ?? "none" } : {}),
    editable: mcpEditable(c),
  };
}

export function mcpEditHandlers(deps: McpEditDeps): Record<string, HandlerDef> {
  const { services } = deps;
  const find = (serverId: string) => {
    const entry = readEntries(services, deps.settingKey).find((c) => c.id === serverId);
    if (entry === undefined) throw new PsycheError("not_found", `no MCP server ${serverId}`);
    return entry;
  };
  const audit = (kind: string, serverId: string, data: Record<string, string | boolean>) =>
    services.audit
      .append({ kind, actor: { type: "system" }, subject: { serverId }, data })
      .catch(() => undefined);

  // A probe failure can quote the stored address: redact it before it leaves.
  const urlsOf = (...cs: PsycheMcpServerConfig[]): string[] =>
    cs.flatMap((c) => (c.transport.kind === "http" ? [c.transport.url] : []));
  const proposeFor =
    (known: string[]): McpAdder["propose"] =>
    (input, extra) =>
      deps.adder.propose(input, extra).catch((err: unknown) => {
        throw scrubError(err, known);
      });

  return {
    "mcp.config": {
      run(_call, params: { serverId: string }) {
        return { config: configView(find(params.serverId)) };
      },
    },
    "mcp.update": {
      async run(_call, params: { id: string; changes: McpServerChanges }) {
        const prev = find(params.id);
        if (params.changes.url !== undefined && urlHoldsMarker(params.changes.url)) {
          throw new PsycheError(
            "invalid_params",
            "the address still has hidden parts (***); enter the full new address",
            { details: { reason: "url_redacted" } },
          );
        }
        const next = applyChanges(prev, params.changes);
        const sameRun = canonical(runIdentity(prev)) === canonical(runIdentity(next));
        if (sameRun) {
          // Cosmetic: the display name. The server keeps running.
          if (next.name === prev.name) return { applied: true, server: deps.status(prev) };
          const value = readEntries(services, deps.settingKey).map((c) =>
            c.id === prev.id ? { ...c, name: next.name } : c,
          );
          const saved = setSetting(services.db, deps.settingKey, value);
          services.publish("settings.changed", { entries: [saved] });
          await deps.apply(value);
          await audit("mcp.server_renamed", prev.id, {
            from: prev.name.slice(0, 100),
            to: next.name.slice(0, 100),
          });
          return { applied: true, server: deps.status({ ...prev, name: next.name }) };
        }
        if (!mcpEditable(prev)) {
          throw new PsycheError(
            "invalid_params",
            "this server's command and connection can't be edited; remove it and add another",
            { details: { reason: "not_editable" } },
          );
        }
        // The owner's word that a server does not move money is a statement about the old
        // command: it does not carry over. "Always" is stricter and stays.
        if (prev.handlesMoney === true) next.handlesMoney = true;
        else delete next.handlesMoney;
        const base = sha(runIdentity(prev));
        const { fields, out } = describeChange(prev, next);
        const { proposal, approval } = await proposeFor(urlsOf(prev, next))(inputOfAny(next), {
          config: next,
          replace: true,
          summary: (found) =>
            `Update MCP server "${next.name}" (${fields.join(", ")}; ${found.tools.length} tools${found.network.reaches ? `, reaches ${found.network.hosts.join(", ").slice(0, 120)}` : ", no network"})`,
          details: {
            replaces: true,
            change: { fields, ...out },
            ...(next.transport.kind === "http" ? { url: redactUrl(next.transport.url) } : {}),
          },
          bind: { replaces: base },
          async precommit() {
            // The server changed since the card was made (another edit, another device).
            const cur = readEntries(services, deps.settingKey).find((c) => c.id === prev.id);
            if (cur === undefined || !mcpEditable(cur) || sha(runIdentity(cur)) !== base) {
              throw new PsycheError(
                "conflict",
                "the server changed since this edit was checked; edit it again",
              );
            }
            // The owner's current choices win over the snapshot the edit started from, a rename
            // included (unless this very edit renames).
            if (params.changes.name === undefined) next.name = cur.name;
            if (cur.handlesMoney === true) next.handlesMoney = true;
            else delete next.handlesMoney;
            if (cur.disabledTools === undefined) delete next.disabledTools;
            else next.disabledTools = [...cur.disabledTools];
            if (cur.enabled === false) next.enabled = false;
            else delete next.enabled;
          },
          async committed() {
            await audit("mcp.server_updated", prev.id, {
              fields: fields.join(","),
              approved: true,
            });
          },
        });
        await audit("mcp.update_proposed", prev.id, {
          fields: fields.join(","),
          approvalId: approval.id,
        });
        return {
          applied: false,
          server: deps.status(prev),
          proposal: { ...proposal, server: redactedInput(proposal.server) },
          approval,
        };
      },
    },
    "mcp.test": {
      async run(_call, params: { id: string }) {
        // Takes no config: only what is stored (and so already approved) is ever started.
        const entry = find(params.id);
        if (entry.enabled === false) {
          throw new PsycheError("unavailable", "the server is paused; turn it on to test it", {
            details: { reason: "paused" },
          });
        }
        const clip = (s: string) => s.slice(0, 500);
        try {
          const live = await deps.ping(entry.id);
          if (live !== undefined) return { ok: true, toolCount: live.length, tools: live };
        } catch (err) {
          return {
            ok: false,
            toolCount: 0,
            tools: [] as string[],
            error: clip(redactText(PsycheError.from(err).message, urlsOf(entry))),
          };
        }
        if (!mcpEditable(entry)) {
          // Its code or record no longer matches what was approved: the Gateway does not run it,
          // and a test must not run it either.
          throw new PsycheError("unavailable", "the Gateway is not running this server", {
            details: { reason: "not_running" },
          });
        }
        try {
          const found = await deps.adder.test(entry);
          return {
            ok: true,
            toolCount: found.tools.length,
            tools: found.tools.map((t) => t.name),
          };
        } catch (err) {
          return {
            ok: false,
            toolCount: 0,
            tools: [] as string[],
            error: clip(redactText(PsycheError.from(err).message, urlsOf(entry))),
          };
        }
      },
    },
  };
}
