import { sanitizeDisplay } from "@psyche/permissions/cards";
import type {
  McpProposal,
  McpServerInput,
  McpServerSecret,
  McpServerStatus,
  McpServerTool,
} from "@psyche/protocol";
import { type ReactNode, useEffect, useState } from "react";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { McpTrustCard } from "./McpTrustCard.tsx";
import { TrustApproval } from "./SkillsSection.tsx";
import { messageOf } from "./shared.tsx";

/**
 * MCP servers in Settings → Connectors (#529; architecture §4.9, security §11). Adding one: a
 * command (run sandboxed) or an HTTPS URL → "Check server" runs it in the sandbox and lists its
 * tools (`mcp.probe`) → the trust card shows the tools, where it can reach and how it runs, with
 * the device-only approval under it → approved, it is added (`mcp.add`).
 */

const show = (s: string, max = 64) => sanitizeDisplay(s, max);

/**
 * A key a preset needs: stored in the vault (bound to this server) just before the probe, and
 * referenced from the server's config as `{{cred:slug}}`. Removed again if the server is not added.
 */
export interface McpSecret {
  slug: string;
  name: string;
  token: string;
  /** For a remote server's bearer header. */
  header?: { name: string; prefix: string };
}

export interface McpState {
  servers: readonly McpServerStatus[];
  launcher: "srt" | "container" | "none";
  loading: boolean;
  error: string | null;
  reload: () => void;
  checking: boolean;
  /** An add that failed or a remove that failed, in words. */
  actionError: string | null;
  /** The last add / remove / denial, in words. */
  notice: string | null;
  /** The trust card under review, with its approval. */
  review: ReactNode;
  check: (input: McpServerInput, secrets?: readonly McpSecret[]) => void;
  remove: (server: McpServerStatus) => void;
  /** Turns a server off (kept in the list, not running) or back on. */
  setEnabled: (server: McpServerStatus, enabled: boolean) => void;
}

export function useMcp(now?: number): McpState {
  const call = useCall();
  const q = useGatewayQuery("mcp.status", {});
  const [proposal, setProposal] = useState<{
    proposal: McpProposal;
    approvalId: string;
    /** Vault items stored for this probe; deleted unless the server is added. */
    credentialIds: readonly string[];
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dropSecrets = (ids: readonly string[]) => {
    for (const credentialId of ids) void call("vault.delete", { credentialId }).catch(() => {});
  };

  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = proposal;
    if (current === null) return;
    setProposal(null);
    if (status !== "approved") {
      dropSecrets(current.credentialIds);
      setNotice(
        status === "denied"
          ? t("settings.mcp.denied", { name: show(current.proposal.server.name) })
          : t("settings.mcp.lapsed"),
      );
      return;
    }
    call("mcp.add", { proposalId: current.proposal.id, approvalId: current.approvalId }).then(
      () => {
        q.reload();
        setNotice(t("settings.mcp.added", { name: show(current.proposal.server.name) }));
      },
      (err: unknown) => {
        dropSecrets(current.credentialIds);
        setActionError(messageOf(err));
      },
    );
  };

  return {
    servers: q.data?.servers ?? [],
    launcher: q.data?.launcher ?? "none",
    loading: q.loading && q.data === undefined,
    error: q.error,
    reload: q.reload,
    checking,
    actionError,
    notice,
    review:
      proposal === null ? null : (
        <McpTrustCard
          proposal={proposal.proposal}
          onCancel={() => {
            dropSecrets(proposal.credentialIds);
            setProposal(null);
          }}
        >
          <TrustApproval
            key={proposal.approvalId}
            approvalId={proposal.approvalId}
            onDecided={decided}
            {...(now === undefined ? {} : { now })}
          />
        </McpTrustCard>
      ),
    check: (input, secrets = []) => {
      setActionError(null);
      setNotice(null);
      setChecking(true);
      const stored: string[] = [];
      (async () => {
        for (const k of secrets) {
          const r = await call("vault.add", {
            kind: "api_key",
            name: k.name,
            slug: k.slug,
            bindings: [{ connector: `mcp:${input.id}` }],
            secret: {
              token: k.token,
              ...(k.header ? { headerName: k.header.name, headerPrefix: k.header.prefix } : {}),
            },
          });
          stored.push(r.credential.id);
        }
        const r = await call("mcp.probe", { server: input });
        setProposal({ proposal: r.proposal, approvalId: r.approval.id, credentialIds: stored });
      })()
        .catch((err: unknown) => {
          dropSecrets(stored);
          setActionError(messageOf(err));
        })
        .finally(() => setChecking(false));
    },
    setEnabled: (s, enabled) => {
      setActionError(null);
      call("mcp.setEnabled", { serverId: s.id, enabled }).then(
        () => {
          q.reload();
          setNotice(
            t(enabled ? "settings.mcp.turnedOn" : "settings.mcp.turnedOff", { name: show(s.name) }),
          );
        },
        (err: unknown) => setActionError(messageOf(err)),
      );
    },
    remove: (s) => {
      setActionError(null);
      call("mcp.remove", { serverId: s.id }).then(
        () => {
          q.reload();
          setNotice(t("settings.mcp.removed", { name: show(s.name) }));
        },
        (err: unknown) => setActionError(messageOf(err)),
      );
    },
  };
}

export interface McpToolsState {
  tools: readonly McpServerTool[];
  /** False while the server is off or not connected: there is nothing to list. */
  available: boolean;
  loading: boolean;
  error: string | null;
  /** A tool change that failed, in words. */
  actionError: string | null;
  /** The tool being changed. */
  busy: string | null;
  set: (tool: string, enabled: boolean) => void;
}

/**
 * A server's tools and which the agent is offered (`mcp.tools`, `mcp.tools.set`). Loads while the
 * detail is open, and again when the server connects or disconnects.
 */
export function useMcpTools(server: McpServerStatus, open: boolean): McpToolsState {
  const call = useCall();
  const live = server.connected && server.enabled !== false;
  const q = useGatewayQuery("mcp.tools", { serverId: server.id }, { enabled: open });
  const { reload } = q;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of `live` is the trigger
  useEffect(() => {
    if (open) reload();
  }, [live, open, reload]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  return {
    tools: q.data?.tools ?? [],
    available: q.data?.available ?? false,
    loading: q.loading && q.data === undefined,
    error: q.error,
    actionError,
    busy,
    set: (tool, enabled) => {
      setActionError(null);
      setBusy(tool);
      call("mcp.tools.set", { serverId: server.id, tool, enabled })
        .then(() => reload())
        .catch((err: unknown) => setActionError(messageOf(err)))
        .finally(() => setBusy(null));
    },
  };
}

export interface McpSecretsState {
  secrets: readonly McpServerSecret[];
  loading: boolean;
  error: string | null;
  actionError: string | null;
  /** The name being replaced. */
  busy: string | null;
  /** The last replacement, in words. */
  notice: string | null;
  /** Stores a new value (it goes to the vault, never back to this screen). */
  replace: (name: string, value: string) => Promise<boolean>;
}

/** A server's env variables and bearer token by name (`mcp.secrets`, `mcp.secrets.replace`). */
export function useMcpSecrets(server: McpServerStatus, open: boolean): McpSecretsState {
  const call = useCall();
  const q = useGatewayQuery("mcp.secrets", { serverId: server.id }, { enabled: open });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return {
    secrets: q.data?.secrets ?? [],
    loading: q.loading && q.data === undefined,
    error: q.error,
    actionError,
    busy,
    notice,
    replace: async (name, value) => {
      setActionError(null);
      setNotice(null);
      setBusy(name);
      try {
        await call("mcp.secrets.replace", { serverId: server.id, name, value });
        q.reload();
        setNotice(t("settings.mcp.secrets.replaced", { name }));
        return true;
      } catch (err) {
        setActionError(messageOf(err));
        return false;
      } finally {
        setBusy(null);
      }
    },
  };
}
