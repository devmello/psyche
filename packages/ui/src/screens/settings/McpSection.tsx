import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { McpProposal, McpServerInput, McpServerStatus } from "@psyche/protocol";
import { Cable } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { EmptyState } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import { TrustApproval } from "./SkillsSection.tsx";
import {
  ErrorNotice,
  Facts,
  Group,
  LoadGate,
  type LoadProps,
  messageOf,
  RadioField,
  SectionFrame,
  StatusChip,
} from "./shared.tsx";

/**
 * Settings → MCP (#529; architecture §4.9, security §11). MCP servers give the agent tools from
 * outside Psyche. Adding one: a command (run sandboxed) or an HTTPS URL → "Check server" runs it
 * in the sandbox and lists its tools (`mcp.probe`) → the trust card shows the tools, where it can
 * reach and how it runs, with the device-only approval under it → approved, it is added
 * (`mcp.add`). Tool names and descriptions are written by the server: shown as data.
 */

const show = (s: string, max = 300) => sanitizeDisplay(s, max);

/** `npx -y @scope/server --flag "two words"` → argv; no shell, quotes group words. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter((x) => x !== "");
}

/** A stable id from the name: `My Files!` → `my-files`. */
export function serverId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(slug) && slug.length >= 2 ? slug : `mcp-${slug || "server"}`.slice(0, 40);
}

type Kind = "command" | "url";

export interface McpDraft {
  name: string;
  kind: Kind;
  command: string;
  url: string;
  domains: string;
}

export function toServerInput(d: McpDraft): McpServerInput {
  const name = d.name.trim();
  if (d.kind === "url") {
    return { id: serverId(name), name, transport: { kind: "http", url: d.url.trim() } };
  }
  const domains = d.domains
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return {
    id: serverId(name),
    name,
    transport: { kind: "stdio", command: splitCommand(d.command) },
    ...(domains.length > 0 ? { allowedDomains: domains } : {}),
  };
}

const EMPTY: McpDraft = { name: "", kind: "command", command: "", url: "", domains: "" };

function AddForm({
  commandsAllowed,
  checking,
  onCheck,
  onCancel,
}: {
  commandsAllowed: boolean;
  checking: boolean;
  onCheck: (draft: McpDraft) => void;
  onCancel: () => void;
}): ReactElement {
  const id = useId();
  const [d, setD] = useState<McpDraft>({ ...EMPTY, kind: commandsAllowed ? "command" : "url" });
  const ready =
    d.name.trim() !== "" &&
    (d.kind === "url" ? /^https:\/\/\S+$/.test(d.url.trim()) : splitCommand(d.command).length > 0);
  return (
    <Group title={t("settings.mcp.add")} description={t("settings.mcp.addHint")}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t("settings.mcp.name")}</Label>
          <Input
            id={`${id}-name`}
            value={d.name}
            maxLength={100}
            onChange={(e) => setD({ ...d, name: e.target.value })}
          />
        </div>
        <RadioField
          label={t("settings.mcp.how")}
          value={d.kind}
          onChange={(kind) => setD({ ...d, kind })}
          options={[
            {
              value: "command",
              label: t("settings.mcp.kind.command"),
              hint: commandsAllowed
                ? t("settings.mcp.kind.commandHint")
                : t("settings.mcp.kind.commandUnavailable"),
            },
            {
              value: "url",
              label: t("settings.mcp.kind.url"),
              hint: t("settings.mcp.kind.urlHint"),
            },
          ]}
        />
        {d.kind === "command" ? (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-cmd`}>{t("settings.mcp.command")}</Label>
              <Input
                id={`${id}-cmd`}
                className="font-mono"
                placeholder={t("settings.mcp.placeholder.command")}
                value={d.command}
                onChange={(e) => setD({ ...d, command: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-domains`}>{t("settings.mcp.domains")}</Label>
              <Input
                id={`${id}-domains`}
                placeholder={t("settings.mcp.placeholder.domains")}
                value={d.domains}
                onChange={(e) => setD({ ...d, domains: e.target.value })}
                aria-describedby={`${id}-domains-hint`}
              />
              <p id={`${id}-domains-hint`} className="text-xs text-muted-foreground">
                {t("settings.mcp.domainsHint")}
              </p>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-url`}>{t("settings.mcp.url")}</Label>
            <Input
              id={`${id}-url`}
              type="url"
              placeholder={t("settings.mcp.placeholder.url")}
              value={d.url}
              onChange={(e) => setD({ ...d, url: e.target.value })}
            />
          </div>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!ready || checking || (d.kind === "command" && !commandsAllowed)}
            onClick={() => onCheck(d)}
          >
            {checking ? t("settings.mcp.checking") : t("settings.mcp.check")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Group>
  );
}

const TIER_TONE = { read: "info", write: "approval", destructive: "danger" } as const;

/** "3 tools: 2 read, 1 changes things · 1 off" in plain words. */
function tierSummary(p: McpProposal): string {
  const count = (tier: string) => p.tools.filter((x) => x.sideEffect === tier).length;
  const parts = (["read", "write", "destructive"] as const)
    .filter((tier) => count(tier) > 0)
    .map((tier) => t(`settings.mcp.trust.tierCount.${tier}`, { n: count(tier) }));
  const off = p.tools.filter((x) => x.blocked).length;
  return [
    t("settings.mcp.trust.toolCount", { n: p.tools.length }),
    parts.join(", "),
    off > 0 ? t("settings.mcp.trust.offCount", { n: off }) : "",
  ]
    .filter((x) => x !== "")
    .join(" · ");
}

/** What the probe found, with the device-only approval (`children`) under it. */
export function McpTrustCard({
  proposal,
  children,
  onCancel,
}: {
  proposal: McpProposal;
  children?: ReactNode;
  onCancel: () => void;
}): ReactElement {
  const s = proposal.server;
  const how =
    s.transport.kind === "stdio" ? s.transport.command.join(" ") : (s.transport.url as string);
  const runs =
    proposal.isolation === "remote"
      ? t("settings.mcp.runs.remote")
      : proposal.isolation === "container"
        ? t("settings.mcp.runs.container")
        : t("settings.mcp.runs.srt");
  return (
    <section
      aria-label={t("settings.mcp.trust.title", { name: show(s.name, 64) })}
      data-testid="mcp-trust-card"
      className="flex flex-col gap-4 rounded-lg border border-approval-border bg-gray-2 p-4 text-sm"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">
          {t("settings.mcp.trust.title", { name: show(s.name, 64) })}
        </h3>
        <p className="text-muted-foreground">{t("settings.mcp.trust.intro")}</p>
      </div>
      <Facts
        items={[
          { term: t("settings.mcp.trust.runs"), value: runs },
          {
            term: t("settings.mcp.trust.network"),
            value: proposal.network.reaches
              ? proposal.network.hosts.map((h) => show(h, 253)).join(", ")
              : t("settings.mcp.trust.noNetwork"),
          },
          {
            term: t("settings.mcp.trust.tools"),
            // Level 1: what the tools can do; their names and descriptions are one level down.
            value: tierSummary(proposal),
          },
        ]}
      />
      <details className="rounded-md border border-gray-6 p-2">
        <summary className="cursor-pointer font-medium">
          {t("settings.mcp.trust.seeTools", { n: proposal.tools.length })}
        </summary>
        <ul className="mt-2 flex flex-col gap-2" aria-label={t("settings.mcp.trust.tools")}>
          {proposal.tools.map((tool) => (
            <li key={tool.name} className="rounded-md border border-gray-6 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{show(tool.name, 128)}</span>
                <StatusChip tone={TIER_TONE[tool.sideEffect]}>
                  {t(`settings.mcp.tier.${tool.sideEffect}`)}
                </StatusChip>
                {tool.blocked ? (
                  <StatusChip tone="danger">{t("settings.mcp.trust.blocked")}</StatusChip>
                ) : tool.warnings.length > 0 ? (
                  <StatusChip tone="approval">
                    {t("settings.mcp.trust.warnings", { n: tool.warnings.length })}
                  </StatusChip>
                ) : null}
              </div>
              {tool.description ? (
                // Written by the server: data, never instructions.
                <p className="mt-1 text-muted-foreground">{show(tool.description, 400)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("settings.mcp.trust.details")}</summary>
        <Facts
          className="mt-2"
          items={[
            { term: t("settings.mcp.trust.id"), value: <code>{s.id}</code> },
            { term: t("settings.mcp.trust.how"), value: <code>{show(how, 500)}</code> },
            {
              term: t("settings.mcp.trust.hash"),
              value: <code>{proposal.toolsListHash.slice(0, 23)}</code>,
            },
          ]}
        />
        {proposal.diagnostics ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-3 p-2">
            {show(proposal.diagnostics, 2_000)}
          </pre>
        ) : null}
      </details>
      {children}
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </section>
  );
}

export interface McpPanelProps extends LoadProps {
  servers: readonly McpServerStatus[];
  launcher: "srt" | "container" | "none";
  checking?: boolean;
  actionError?: string | null;
  notice?: string | null;
  /** The trust card under review (connected: with its approval). */
  review?: ReactNode;
  onCheck?: (draft: McpDraft) => void;
  onRemove?: (server: McpServerStatus) => void;
  defaultAdding?: boolean;
}

export function McpPanel({
  servers,
  launcher,
  checking = false,
  actionError = null,
  notice = null,
  review,
  onCheck,
  onRemove,
  defaultAdding = false,
  loading,
  error,
  onRetry,
}: McpPanelProps): ReactElement {
  const [adding, setAdding] = useState(defaultAdding);
  const addButton = onCheck ? (
    <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding}>
      <Cable aria-hidden="true" /> {t("settings.mcp.add")}
    </Button>
  ) : null;
  return (
    <SectionFrame
      title={t("settings.mcp.title")}
      description={t("settings.mcp.description")}
      actions={servers.length > 0 ? addButton : null}
    >
      <LoadGate
        label={t("settings.mcp.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <div role="status" className="text-sm">
          {notice ? <p>{notice}</p> : null}
        </div>
        {actionError ? (
          <ErrorNotice what={actionError} did={t("settings.skills.nothingChanged")} />
        ) : null}
        {review}
        {adding && onCheck && review === undefined ? (
          <AddForm
            commandsAllowed={launcher !== "none"}
            checking={checking}
            onCancel={() => setAdding(false)}
            onCheck={(d) => onCheck(d)}
          />
        ) : null}
        {servers.length === 0 ? (
          adding ? null : (
            <EmptyState
              icon={Cable}
              className="elevation-1 py-10"
              {...(onCheck
                ? { action: { label: t("settings.mcp.add"), onClick: () => setAdding(true) } }
                : {})}
            >
              {t("settings.mcp.empty")}
            </EmptyState>
          )
        ) : (
          <ul className="flex flex-col gap-3">
            {servers.map((s) => (
              <li key={s.id}>
                <article
                  aria-label={s.name}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
                >
                  <h3 className="text-base font-semibold">{show(s.name, 100)}</h3>
                  <StatusChip tone={s.connected ? "success" : "danger"}>
                    {s.connected ? t("settings.mcp.connected") : t("settings.mcp.notConnected")}
                  </StatusChip>
                  <StatusChip tone="neutral">
                    {s.transport === "http"
                      ? t("settings.mcp.kind.url")
                      : t("settings.mcp.kind.command")}
                  </StatusChip>
                  {s.network ? (
                    <StatusChip tone="approval">{t("settings.mcp.network")}</StatusChip>
                  ) : null}
                  <span className="flex-1" />
                  {onRemove ? (
                    <RowMoreMenu
                      name={s.name}
                      destructive={[
                        {
                          label: t("common.remove"),
                          title: t("settings.mcp.removeTitle", { name: show(s.name, 64) }),
                          description: t("settings.mcp.removeDescription"),
                          confirm: t("common.remove"),
                          onConfirm: () => onRemove(s),
                        },
                      ]}
                    />
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        )}
      </LoadGate>
    </SectionFrame>
  );
}

export function McpSection({ now }: { now?: number }): ReactElement {
  const call = useCall();
  const q = useGatewayQuery("mcp.status", {});
  const [review, setReview] = useState<{ proposal: McpProposal; approvalId: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = review;
    if (current === null) return;
    setReview(null);
    if (status !== "approved") {
      setNotice(
        status === "denied"
          ? t("settings.mcp.denied", { name: show(current.proposal.server.name, 64) })
          : t("settings.mcp.lapsed"),
      );
      return;
    }
    call("mcp.add", { proposalId: current.proposal.id, approvalId: current.approvalId }).then(
      () => {
        q.reload();
        setNotice(t("settings.mcp.added", { name: show(current.proposal.server.name, 64) }));
      },
      (err: unknown) => setActionError(messageOf(err)),
    );
  };

  return (
    <McpPanel
      servers={q.data?.servers ?? []}
      launcher={q.data?.launcher ?? "none"}
      loading={q.loading && q.data === undefined}
      error={q.error}
      onRetry={q.reload}
      checking={checking}
      actionError={actionError}
      notice={notice}
      {...(review === null
        ? {}
        : {
            review: (
              <McpTrustCard proposal={review.proposal} onCancel={() => setReview(null)}>
                <TrustApproval
                  key={review.approvalId}
                  approvalId={review.approvalId}
                  onDecided={decided}
                  {...(now === undefined ? {} : { now })}
                />
              </McpTrustCard>
            ),
          })}
      onCheck={(d) => {
        setActionError(null);
        setNotice(null);
        setChecking(true);
        call("mcp.probe", { server: toServerInput(d) })
          .then(
            (r) => setReview({ proposal: r.proposal, approvalId: r.approval.id }),
            (err: unknown) => setActionError(messageOf(err)),
          )
          .finally(() => setChecking(false));
      }}
      onRemove={(s) => {
        setActionError(null);
        call("mcp.remove", { serverId: s.id }).then(
          () => {
            q.reload();
            setNotice(t("settings.mcp.removed", { name: show(s.name, 64) }));
          },
          (err: unknown) => setActionError(messageOf(err)),
        );
      }}
    />
  );
}
