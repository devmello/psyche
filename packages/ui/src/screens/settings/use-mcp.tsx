import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { McpProposal, McpServerStatus } from "@psyche/protocol";
import { type ReactNode, useState } from "react";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { McpTrustCard } from "./McpTrustCard.tsx";
import { type McpDraft, toServerInput } from "./mcp-input.ts";
import { TrustApproval } from "./SkillsSection.tsx";
import { messageOf } from "./shared.tsx";

/**
 * MCP servers in Settings → Connectors (#529; architecture §4.9, security §11). Adding one: a
 * command (run sandboxed) or an HTTPS URL → "Check server" runs it in the sandbox and lists its
 * tools (`mcp.probe`) → the trust card shows the tools, where it can reach and how it runs, with
 * the device-only approval under it → approved, it is added (`mcp.add`).
 */

const show = (s: string, max = 64) => sanitizeDisplay(s, max);

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
  check: (draft: McpDraft) => void;
  remove: (server: McpServerStatus) => void;
}

export function useMcp(now?: number): McpState {
  const call = useCall();
  const q = useGatewayQuery("mcp.status", {});
  const [proposal, setProposal] = useState<{ proposal: McpProposal; approvalId: string } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = proposal;
    if (current === null) return;
    setProposal(null);
    if (status !== "approved") {
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
      (err: unknown) => setActionError(messageOf(err)),
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
        <McpTrustCard proposal={proposal.proposal} onCancel={() => setProposal(null)}>
          <TrustApproval
            key={proposal.approvalId}
            approvalId={proposal.approvalId}
            onDecided={decided}
            {...(now === undefined ? {} : { now })}
          />
        </McpTrustCard>
      ),
    check: (d) => {
      setActionError(null);
      setNotice(null);
      setChecking(true);
      call("mcp.probe", { server: toServerInput(d) })
        .then(
          (r) => setProposal({ proposal: r.proposal, approvalId: r.approval.id }),
          (err: unknown) => setActionError(messageOf(err)),
        )
        .finally(() => setChecking(false));
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
