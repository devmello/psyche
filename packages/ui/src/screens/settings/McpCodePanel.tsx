import { sanitizeBlock, sanitizeDisplay } from "@psyche/permissions/cards";
import type { McpProposal, McpServerStatus } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { McpTrustCard } from "./McpTrustCard.tsx";
import { TrustApproval } from "./SkillsSection.tsx";
import { messageOf } from "./shared.tsx";

/**
 * "Code" of a connector Psyche wrote (`mcp.files.read`): read-only by default. Editing a file
 * (`mcp.files.write`) stops the connector, then shows the same trust card as any change, with the
 * diff and the device-only approval under it; approved, it starts again (`mcp.add`).
 */

const show = (s: string, max = 64) => sanitizeDisplay(s, max);

export function McpCodePanel({
  server,
  onChanged,
  now,
}: {
  server: McpServerStatus;
  /** The server list should be read again (the connector stopped or started). */
  onChanged?: () => void;
  now?: number;
}): ReactElement {
  const call = useCall();
  const [open, setOpen] = useState(false);
  const q = useGatewayQuery("mcp.files.read", { serverId: server.id }, { enabled: open });
  const [editing, setEditing] = useState<{ path: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<{ proposal: McpProposal; approvalId: string } | null>(null);
  const data = q.data;

  const save = () => {
    if (editing === null) return;
    setSaving(true);
    setError(null);
    call("mcp.files.write", { serverId: server.id, path: editing.path, content: editing.text })
      .then((r) => {
        setEditing(null);
        setReview({ proposal: r.proposal, approvalId: r.approval.id });
        onChanged?.();
        q.reload();
      })
      .catch((err: unknown) => setError(messageOf(err)))
      .finally(() => setSaving(false));
  };

  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = review;
    if (current === null) return;
    setReview(null);
    if (status !== "approved") {
      setNotice(t("settings.mcp.code.denied", { name: show(server.name) }));
      return;
    }
    call("mcp.add", { proposalId: current.proposal.id, approvalId: current.approvalId }).then(
      () => {
        setNotice(t("settings.mcp.code.approved", { name: show(server.name) }));
        onChanged?.();
        q.reload();
      },
      (err: unknown) => setError(messageOf(err)),
    );
  };

  return (
    <section
      className="ms-11 flex flex-col gap-2"
      aria-label={t("settings.mcp.code.title")}
      data-testid="mcp-code-panel"
    >
      <p className="text-callout text-label-secondary">{t("settings.mcp.madeByHint")}</p>
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? t("settings.mcp.code.hide") : t("settings.mcp.code.view")}
        </Button>
      </div>
      {notice !== null ? <p role="status">{notice}</p> : null}
      {error !== null ? (
        <p role="alert" className="text-danger-text">
          {error}
        </p>
      ) : null}
      {review !== null ? (
        <McpTrustCard proposal={review.proposal} onCancel={() => setReview(null)}>
          <TrustApproval
            key={review.approvalId}
            approvalId={review.approvalId}
            onDecided={decided}
            {...(now === undefined ? {} : { now })}
          />
        </McpTrustCard>
      ) : null}
      {open && q.loading && data === undefined ? (
        <p className="text-callout text-label-secondary">{t("settings.mcp.code.loading")}</p>
      ) : null}
      {open && data !== undefined ? (
        <div className="flex flex-col gap-2">
          <p className="text-callout text-label-secondary">
            {t("settings.mcp.code.version", {
              version: data.version,
              runtime: data.runtime,
              entry: show(data.entry, 100),
            })}
          </p>
          {data.modified ? (
            <p role="status" className="text-approval-text">
              {t("settings.mcp.code.modified")}
            </p>
          ) : null}
          {data.files.map((f) => (
            <details key={f.path} className="rounded-md border border-separator p-2">
              <summary className="cursor-default text-mono">
                {t("settings.mcp.code.file", { path: show(f.path, 120), bytes: f.bytes })}
              </summary>
              {editing?.path === f.path ? (
                <div className="mt-1 flex flex-col gap-2">
                  <textarea
                    aria-label={t("settings.mcp.code.editing", { file: show(f.path, 120) })}
                    className="min-h-40 w-full rounded-md bg-fill-quaternary p-2 text-mono"
                    value={editing.text}
                    onChange={(e) => setEditing({ path: f.path, text: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" disabled={saving} onClick={save}>
                      {saving ? t("settings.mcp.code.saving") : t("settings.mcp.code.save")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      {t("settings.mcp.code.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-fill-quaternary p-2 text-mono whitespace-pre-wrap">
                    {sanitizeBlock(f.content)}
                  </pre>
                  {f.path === "mcp-lite.mjs" ? (
                    <p className="text-callout text-label-secondary">
                      {t("settings.mcp.code.provided")}
                    </p>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing({ path: f.path, text: f.content })}
                    >
                      {t("settings.mcp.code.edit", { file: show(f.path, 120) })}
                    </Button>
                  )}
                </>
              )}
            </details>
          ))}
        </div>
      ) : null}
    </section>
  );
}
