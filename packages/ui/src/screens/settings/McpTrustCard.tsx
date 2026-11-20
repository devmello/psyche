import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { McpProposal } from "@psyche/protocol";
import type { ReactElement, ReactNode } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { Facts, StatusChip } from "./shared.tsx";

/**
 * The trust card for an MCP server being added (architecture §4.9, security §11): what the probe
 * found, where the server can reach and how it runs, with the device-only approval under it.
 * Tool names and descriptions are written by the server: shown as data.
 */

const show = (s: string, max = 300) => sanitizeDisplay(s, max);

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

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * What an edit changes, old and new, by name: the Gateway sends names and addresses, never a
 * variable's value. Everything in it came from the config or the server: shown as data.
 */
function ChangeRows({ change }: { change: Record<string, unknown> }): ReactElement {
  const none = t("settings.mcp.trust.change.none");
  const pair = (term: string, was: string, now: string) => ({
    term,
    value: (
      <span className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">
          {t("settings.mcp.trust.change.was", { value: show(was || none, 500) })}
        </span>
        <span>{t("settings.mcp.trust.change.now", { value: show(now || none, 500) })}</span>
      </span>
    ),
  });
  const list = (term: string, names: string[]) => ({
    term,
    value: names.map((n) => show(n, 64)).join(", "),
  });
  const items = [
    ...("newCommand" in change
      ? [
          pair(
            t("settings.mcp.trust.change.command"),
            text(change.oldCommand),
            text(change.newCommand),
          ),
        ]
      : []),
    ...("newUrl" in change
      ? [pair(t("settings.mcp.trust.change.url"), text(change.oldUrl), text(change.newUrl))]
      : []),
    ...("newDomains" in change
      ? [
          pair(
            t("settings.mcp.trust.change.domains"),
            strings(change.oldDomains).join(", "),
            strings(change.newDomains).join(", "),
          ),
        ]
      : []),
    ...("newAuth" in change
      ? [pair(t("settings.mcp.trust.change.auth"), text(change.oldAuth), text(change.newAuth))]
      : []),
    ...(strings(change.queryChanged).length > 0
      ? [list(t("settings.mcp.trust.change.query"), strings(change.queryChanged))]
      : []),
    ...(change.userinfoChanged === true
      ? [
          {
            term: t("settings.mcp.trust.change.userinfo"),
            value: t("settings.mcp.trust.change.changed"),
          },
        ]
      : []),
    ...(strings(change.envAdded).length > 0
      ? [list(t("settings.mcp.trust.change.envAdded"), strings(change.envAdded))]
      : []),
    ...(strings(change.envRemoved).length > 0
      ? [list(t("settings.mcp.trust.change.envRemoved"), strings(change.envRemoved))]
      : []),
    ...(strings(change.envChanged).length > 0
      ? [list(t("settings.mcp.trust.change.envChanged"), strings(change.envChanged))]
      : []),
  ];
  return (
    <div className="flex flex-col gap-1" data-testid="mcp-trust-change">
      <h4 className="font-medium">{t("settings.mcp.trust.change.title")}</h4>
      <Facts items={items} />
    </div>
  );
}

/** What the probe found, with the device-only approval (`children`) under it. */
export function McpTrustCard({
  proposal,
  children,
  onCancel,
  change,
}: {
  proposal: McpProposal;
  children?: ReactNode;
  onCancel: () => void;
  /** An edit of a server already added: what changes, old and new. */
  change?: Record<string, unknown>;
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
      aria-label={t(change ? "settings.mcp.trust.updateTitle" : "settings.mcp.trust.title", {
        name: show(s.name, 64),
      })}
      data-testid="mcp-trust-card"
      className="flex flex-col gap-4 rounded-lg border border-approval-border bg-gray-2 p-4 text-sm"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">
          {t(change ? "settings.mcp.trust.updateTitle" : "settings.mcp.trust.title", {
            name: show(s.name, 64),
          })}
        </h3>
        <p className="text-muted-foreground">
          {change ? t("settings.mcp.trust.updateIntro") : t("settings.mcp.trust.intro")}
        </p>
      </div>
      {change ? <ChangeRows change={change} /> : null}
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
      <details className="text-callout text-muted-foreground">
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
