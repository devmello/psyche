import type { AuditChange } from "@psyche/protocol";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { type ReactElement, useState } from "react";
import { ChangeDiff, changeName } from "../chat/ChangeChip.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { type AuditCategory, useChainStatus, useChanges } from "../data/changes.ts";
import { useStore } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { useSlots } from "../slots.tsx";
import { agentTimelineHref } from "./AgentSheet.tsx";

const PAGE = 50;

const FILTERS: { id: string; label: () => string; categories?: AuditCategory[] }[] = [
  { id: "all", label: () => t("audit.filter.all") },
  { id: "file", label: () => t("audit.filter.files"), categories: ["file"] },
  { id: "memory", label: () => t("audit.filter.memory"), categories: ["memory"] },
  { id: "command", label: () => t("audit.filter.commands"), categories: ["command"] },
  { id: "connector", label: () => t("audit.filter.connectors"), categories: ["connector"] },
  { id: "approval", label: () => t("audit.filter.approvals"), categories: ["approval"] },
  { id: "other", label: () => t("audit.filter.other"), categories: ["skill", "setting"] },
];

function actorLabel(c: AuditChange): string {
  const kind =
    c.actor.type === "agent"
      ? t("audit.actor.agent")
      : c.actor.type === "job"
        ? t("audit.actor.job")
        : t("audit.actor.owner");
  return c.actor.name ? t("audit.actor.named", { kind, name: c.actor.name }) : kind;
}

/** The chain status: "Verified", or where it broke. */
export function ChainBadge(): ReactElement {
  const { status, loading } = useChainStatus();
  if (status === undefined) {
    return <Badge variant="muted">{loading ? t("audit.chain.checking") : "-"}</Badge>;
  }
  return status.ok ? (
    <Badge variant="success">
      <ShieldCheck aria-hidden="true" className="size-3" /> {t("audit.chain.verified")}
    </Badge>
  ) : (
    <Badge variant="danger">
      <ShieldAlert aria-hidden="true" className="size-3" />{" "}
      {t("audit.chain.broken", { seq: status.brokenAtSeq ?? 0 })}
    </Badge>
  );
}

function download(name: string, mime: string, data: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Activity → audit: every change to the owner's files, memory, settings and connected apps,
 * from the Gateway's hash-chained records. `threadId` narrows it to one chat.
 */
export function AuditView({
  threadId,
  now: fixedNow,
}: {
  threadId?: string;
  now?: number;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const store = useStore();
  const slots = useSlots();
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const categories = FILTERS.find((f) => f.id === filter)?.categories;
  const params = {
    ...(threadId === undefined ? {} : { threadId }),
    ...(categories === undefined ? {} : { categories }),
    limit,
  };
  const { changes, error, loading } = useChanges(params);
  const exportAs = async (format: "json" | "markdown") => {
    const { categories: cats, threadId: thread } = params;
    const res = await store.call("audit.changesExport", {
      format,
      ...(thread === undefined ? {} : { threadId: thread }),
      ...(cats === undefined ? {} : { categories: cats }),
    });
    download(
      format === "json" ? "psyche-audit.json" : "psyche-audit.md",
      format === "json" ? "application/json" : "text/markdown",
      res.data,
    );
  };
  return (
    <section aria-label={t("audit.title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 px-2">
        <h3 className="text-headline text-label-primary">{t("audit.title")}</h3>
        <ChainBadge />
        <span className="ms-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => void exportAs("json")}>
            {t("audit.export.json")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void exportAs("markdown")}>
            {t("audit.export.markdown")}
          </Button>
        </span>
      </div>
      <p className="px-2 text-callout text-label-secondary">{t("audit.hint")}</p>
      <ToggleGroup
        aria-label={t("audit.filter.label")}
        value={[filter]}
        onValueChange={(v) => {
          const next = v[0];
          if (next !== undefined) {
            setFilter(next);
            setLimit(PAGE);
          }
        }}
        className="flex-wrap px-2"
      >
        {FILTERS.map((f) => (
          <ToggleGroupItem key={f.id} value={f.id}>
            {f.label()}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {error && changes.length === 0 ? (
        <p className="px-2 text-body">{t("audit.loadFailed", { reason: error })}</p>
      ) : null}
      {!loading && changes.length === 0 && !error ? (
        <p className="px-2 text-body text-label-secondary">{t("audit.empty")}</p>
      ) : null}
      <ul className="flex flex-col">
        {changes.map((c) => (
          <li key={c.seq} className="rounded-md px-2 py-2 hover:bg-fill-quaternary">
            <button
              type="button"
              aria-expanded={open === c.seq}
              aria-label={`${t("audit.action", { action: c.action, target: c.target.path ?? changeName(c) })} (${open === c.seq ? t("audit.collapse") : t("audit.expand")})`}
              onClick={() => setOpen(open === c.seq ? null : c.seq)}
              className="flex w-full flex-col gap-0.5 text-start"
            >
              <span className="flex items-center gap-2 text-body text-label-primary">
                <span className="truncate">
                  {t("audit.action", { action: c.action, target: c.target.path ?? changeName(c) })}
                </span>
                {c.outcome === "failed" ? (
                  <Badge variant="danger">{t("audit.failed")}</Badge>
                ) : null}
                {c.stats ? (
                  <span className="text-caption text-label-tertiary tabular-nums">
                    +{c.stats.added} −{c.stats.removed}
                  </span>
                ) : null}
              </span>
              <span className="text-callout text-label-secondary">
                {actorLabel(c)} · {c.tool} · {formatRelative(c.ts, now)}
              </span>
            </button>
            {open === c.seq ? (
              <div className="mt-2 flex flex-col gap-2">
                <ChangeDiff change={c} />
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-caption text-label-secondary">
                  {c.beforeSha256 ? (
                    <>
                      <dt>{t("audit.hash.before")}</dt>
                      <dd className="truncate font-mono">{c.beforeSha256}</dd>
                    </>
                  ) : null}
                  {c.afterSha256 ? (
                    <>
                      <dt>{t("audit.hash.after")}</dt>
                      <dd className="truncate font-mono">{c.afterSha256}</dd>
                    </>
                  ) : null}
                </dl>
                <p className="text-caption text-label-secondary">
                  {[
                    c.threadId ? t("audit.thread", { id: c.threadId }) : null,
                    c.approvalId ? t("audit.approval", { id: c.approvalId }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {c.runId && slots.navigate ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-fit"
                    onClick={() => slots.navigate?.(agentTimelineHref(c.runId ?? ""))}
                  >
                    {t("audit.chip.openTimeline")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {changes.length >= limit ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-fit self-center"
          onClick={() => setLimit(limit + PAGE)}
        >
          {t("audit.loadMore")}
        </Button>
      ) : null}
    </section>
  );
}
