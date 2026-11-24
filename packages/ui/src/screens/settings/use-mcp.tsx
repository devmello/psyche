import { sanitizeDisplay } from "@psyche/permissions/cards";
import type {
  McpProposal,
  McpServerChanges,
  McpServerConfigView,
  McpServerInput,
  McpServerSecret,
  McpServerStatus,
  McpServerTool,
} from "@psyche/protocol";
import { type ReactNode, useContext, useEffect, useState } from "react";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { McpTrustCard } from "./McpTrustCard.tsx";
import { TrustApproval } from "./SkillsSection.tsx";
import { approvalIdOf, messageOf, SettingsApprovalContext } from "./shared.tsx";

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
  launcher: "srt" | "container" | "vm" | "none";
  loading: boolean;
  error: string | null;
  reload: () => void;
  checking: boolean;
  /** An add that failed or a remove that failed, in words. */
  actionError: string | null;
  /** Why a server did not start (`mcp.probe`): the launch failure and the server's own words. */
  actionFailure: McpLaunchFailure | null;
  /** The last add / remove / denial, in words. */
  notice: string | null;
  /** The trust card under review, with its approval. */
  review: ReactNode;
  check: (input: McpServerInput, secrets?: readonly McpSecret[]) => void;
  /**
   * Saves an edit of a server (`mcp.update`). A display name applies at once; anything that
   * changes what runs or where it connects opens the trust card (old → new) first.
   */
  update: (
    server: McpServerStatus,
    changes: McpServerChanges,
    secrets?: readonly McpSecret[],
  ) => void;
  /** Counts finished edits (applied now, or approved on the card): the edit form closes on it. */
  updated: number;
  remove: (server: McpServerStatus) => void;
  /** Turns a server off (kept in the list, not running) or back on. */
  setEnabled: (server: McpServerStatus, enabled: boolean) => void;
  /** A saved secret that could not be deleted, with a retry. Null when all were deleted. */
  secretFailure: { message: string; retry: () => void } | null;
}

export interface McpLaunchFailure {
  failure: string;
  stderr: string;
  exitCode?: number;
}

/** `details` of a probe that could not start the server; null for any other error. */
export function launchFailureOf(err: unknown): McpLaunchFailure | null {
  const d = (err as { details?: Record<string, unknown> } | null)?.details;
  if (d === undefined || d === null || typeof d.failure !== "string") return null;
  return {
    failure: d.failure,
    stderr: typeof d.stderr === "string" ? d.stderr : "",
    ...(typeof d.exitCode === "number" ? { exitCode: d.exitCode } : {}),
  };
}

export function useMcp(now?: number): McpState {
  const call = useCall();
  const q = useGatewayQuery("mcp.status", {});
  const [proposal, setProposal] = useState<{
    proposal: McpProposal;
    approvalId: string;
    /** Vault items stored for this probe; deleted unless the server is added. */
    credentialIds: readonly string[];
    /** Set for an edit: what the card shows as old → new (`details.change` of the approval). */
    change?: Record<string, unknown>;
  } | null>(null);
  const [updated, setUpdated] = useState(0);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<McpLaunchFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A secret that will not delete stays listed with a retry: the owner has to know one is left.
  const [secretFailure, setSecretFailure] = useState<{
    credentialIds: readonly string[];
    reason: string;
  } | null>(null);
  const dropSecrets = (ids: readonly string[]) => {
    for (const credentialId of ids) {
      void call("vault.delete", { credentialId }).catch((err: unknown) => {
        setSecretFailure((prev) => ({
          credentialIds: [...(prev?.credentialIds ?? []), credentialId],
          reason: messageOf(err),
        }));
      });
    }
  };
  const retrySecrets = () => {
    const ids = secretFailure?.credentialIds ?? [];
    setSecretFailure(null);
    dropSecrets(ids);
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
        if (current.change === undefined) {
          setNotice(t("settings.mcp.added", { name: show(current.proposal.server.name) }));
        } else {
          setNotice(t("settings.mcp.updated", { name: show(current.proposal.server.name) }));
          setUpdated((n) => n + 1);
        }
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
    actionFailure,
    notice,
    secretFailure:
      secretFailure === null
        ? null
        : {
            message: t("settings.mcp.secretNotDeleted", { reason: secretFailure.reason }),
            retry: retrySecrets,
          },
    review:
      proposal === null ? null : (
        <McpTrustCard
          proposal={proposal.proposal}
          {...(proposal.change === undefined ? {} : { change: proposal.change })}
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
      setActionFailure(null);
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
          setActionFailure(launchFailureOf(err));
        })
        .finally(() => setChecking(false));
    },
    updated,
    update: (server, changes, secrets = []) => {
      setActionError(null);
      setActionFailure(null);
      setNotice(null);
      setChecking(true);
      const stored: string[] = [];
      (async () => {
        for (const k of secrets) {
          const r = await call("vault.add", {
            kind: "api_key",
            name: k.name,
            slug: k.slug,
            bindings: [{ connector: `mcp:${server.id}` }],
            secret: {
              token: k.token,
              ...(k.header ? { headerName: k.header.name, headerPrefix: k.header.prefix } : {}),
            },
          });
          stored.push(r.credential.id);
        }
        const r = await call("mcp.update", { id: server.id, changes });
        if (r.applied || r.proposal === undefined || r.approval === undefined) {
          dropSecrets(stored);
          q.reload();
          setNotice(t("settings.mcp.updated", { name: show(r.server.name) }));
          setUpdated((n) => n + 1);
          return;
        }
        const change = r.approval.details?.change;
        setProposal({
          proposal: r.proposal,
          approvalId: r.approval.id,
          credentialIds: stored,
          change:
            typeof change === "object" && change !== null
              ? (change as Record<string, unknown>)
              : {},
        });
      })()
        .catch((err: unknown) => {
          dropSecrets(stored);
          setActionError(messageOf(err));
          setActionFailure(launchFailureOf(err));
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

/** The owner's word on whether a server's tools move money (`mcp.handlesMoney.set`). */
export type McpMoneyMode = "auto" | "always" | "never";

export interface McpMoneyState {
  mode: McpMoneyMode;
  busy: boolean;
  /** A change that failed, in words. */
  actionError: string | null;
  set: (mode: McpMoneyMode) => void;
}

const moneyModeOf = (server: McpServerStatus): McpMoneyMode =>
  server.handlesMoney === true ? "always" : server.handlesMoney === false ? "never" : "auto";

/**
 * Whether this server's tools are payments. Anything but "always" lowers protection, so the
 * Gateway first answers `approval_required`: the change waits on the approval banner and is
 * written again once the owner approves.
 */
export function useMcpMoney(server: McpServerStatus): McpMoneyState {
  const call = useCall();
  const requestApproval = useContext(SettingsApprovalContext);
  const [mode, setMode] = useState<McpMoneyMode>(moneyModeOf(server));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fromServer = moneyModeOf(server);
  useEffect(() => setMode(fromServer), [fromServer]);
  return {
    mode,
    busy,
    actionError,
    set: (next) => {
      const run = (approvalId?: string) =>
        call("mcp.handlesMoney.set", {
          serverId: server.id,
          mode: next,
          ...(approvalId === undefined ? {} : { approvalId }),
        }).then(() => setMode(next));
      setActionError(null);
      setBusy(true);
      run()
        .catch((err: unknown) => {
          const id = approvalIdOf(err);
          if (id !== null && requestApproval) {
            requestApproval({
              key: "mcp.servers",
              label: t("settings.mcp.money.title"),
              approvalId: id,
              retry: (approvalId) => run(approvalId),
            });
          } else {
            setActionError(messageOf(err));
          }
        })
        .finally(() => setBusy(false));
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

export interface McpConfigState {
  config: McpServerConfigView | null;
  secrets: readonly McpServerSecret[];
  loading: boolean;
  error: string | null;
}

/** What the edit form is prefilled from: the stored command or URL and the secrets, by name. */
export function useMcpConfig(serverId: string): McpConfigState {
  const c = useGatewayQuery("mcp.config", { serverId });
  const s = useGatewayQuery("mcp.secrets", { serverId });
  return {
    config: c.data?.config ?? null,
    secrets: s.data?.secrets ?? [],
    loading: (c.loading && c.data === undefined) || (s.loading && s.data === undefined),
    error: c.error ?? s.error,
  };
}

export interface McpTestState {
  running: boolean;
  /** The last result: how many tools it listed, or why it failed. */
  result: { ok: true; toolCount: number } | { ok: false; reason: string } | null;
  run: () => void;
}

/** "Test connection" (`mcp.test`): the saved config is checked again; nothing changes. */
export function useMcpTest(server: McpServerStatus): McpTestState {
  const call = useCall();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<McpTestState["result"]>(null);
  return {
    running,
    result,
    run: () => {
      setResult(null);
      setRunning(true);
      call("mcp.test", { id: server.id })
        .then((r) =>
          setResult(
            r.ok
              ? { ok: true, toolCount: r.toolCount }
              : { ok: false, reason: show(r.error ?? "", 300) },
          ),
        )
        .catch((err: unknown) => setResult({ ok: false, reason: messageOf(err) }))
        .finally(() => setRunning(false));
    },
  };
}
