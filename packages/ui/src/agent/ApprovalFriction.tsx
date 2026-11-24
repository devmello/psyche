import type { MethodResult } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { formatDate, formatDuration } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";

type Friction = MethodResult<"audit.friction">;

const WINDOWS = [7, 30] as const;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Rows shown per list; the rest is counted in the sentences above them. */
const ROWS = 5;

const sum = (counts: Readonly<Record<string, number>>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0);

const percent = (rate: number): number => Math.round(rate * 100);

/** The plain name of a rule family: `mode:balanced/write` reads as "Your mode setting". */
function ruleLabel(rule: string): string {
  const family = rule.split(":")[0] ?? "";
  switch (family) {
    case "mode":
      return t("friction.rule.mode");
    case "taint":
      return t("friction.rule.taint");
    case "policy":
      return t("friction.rule.policy");
    case "designated":
      return t("friction.rule.designated");
    case "site":
      return t("friction.rule.site");
    default:
      return t("friction.rule.other");
  }
}

/** The sentences and lists for one window's numbers. Plain text only. */
function FrictionSummary({ data }: { data: Friction }): ReactElement {
  const expired = data.byKind.reduce((a, k) => a + k.expired, 0);
  const p50: number | null | undefined = data.p50AnswerMs;
  const kinds = [...data.byKind]
    .filter((k) => k.asks > 0)
    .sort((a, b) => b.asks - a.asks)
    .slice(0, ROWS);
  const modes = Object.entries(data.byMode).filter(([, m]) => m.decisions > 0);
  return (
    <div className="flex flex-col gap-2 px-2 text-body text-label-primary">
      <p>
        {t("friction.asked", {
          asks: data.asks,
          decisions: data.decisions,
          rate: percent(data.askRate),
        })}
      </p>
      {data.asksPerAskingRun > 0 ? (
        <p>{t("friction.perRun", { n: data.asksPerAskingRun.toFixed(1) })}</p>
      ) : null}
      {data.asks > 0 ? (
        <>
          <p>{t("friction.answered", { rate: percent(data.answerRate) })}</p>
          <p>{t("friction.approved", { rate: percent(data.approveRate) })}</p>
        </>
      ) : null}
      <p>
        {p50 == null
          ? t("friction.noTimes")
          : t("friction.times", {
              p50: formatDuration(p50),
              p90: formatDuration(data.p90AnswerMs ?? p50),
            })}
      </p>
      <p>{t("friction.expired", { n: expired })}</p>
      <p>{t("friction.rejected", { n: sum(data.answerRejections) })}</p>
      <p>{t("friction.saved", { n: data.allowedByGrant })}</p>
      <p>{t("friction.grantsCreated", { n: sum(data.grantsCreated) })}</p>
      {kinds.length > 0 ? (
        <section aria-label={t("friction.kinds")} className="mt-1 flex flex-col gap-1">
          <h4 className="text-callout text-label-secondary">{t("friction.kinds")}</h4>
          <ul className="flex flex-col gap-0.5">
            {kinds.map((k) => (
              <li key={k.kind} className="text-callout tabular-nums">
                {t("friction.kind.row", {
                  kind: k.kind,
                  asks: k.asks,
                  approved: k.approved,
                  declined: k.declined,
                  expired: k.expired,
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.topAskRules.length > 0 ? (
        <section aria-label={t("friction.rules")} className="mt-1 flex flex-col gap-1">
          <h4 className="text-callout text-label-secondary">{t("friction.rules")}</h4>
          <ul className="flex flex-col gap-0.5">
            {data.topAskRules.slice(0, ROWS).map((r) => (
              <li key={r.rule} className="text-callout tabular-nums">
                {t("friction.rule.row", { label: ruleLabel(r.rule), count: r.count })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {modes.length > 0 ? (
        <section aria-label={t("friction.modes")} className="mt-1 flex flex-col gap-1">
          <h4 className="text-callout text-label-secondary">{t("friction.modes")}</h4>
          <ul className="flex flex-col gap-0.5">
            {modes.map(([mode, m]) => (
              <li key={mode} className="text-callout tabular-nums">
                {t("friction.mode.row", { mode, asks: m.asks, decisions: m.decisions })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Activity: how often Psyche asks before acting, how fast and how you answer, what expires, and
 * what standing grants saved asks. Read-only; every number comes from `audit.friction`.
 */
export function ApprovalFriction({ now: fixedNow }: { now?: number }): ReactElement {
  const now = useNow(HOUR, fixedNow);
  const [days, setDays] = useState<number>(WINDOWS[0]);
  // Whole hours, so the window's start (and the query) stays the same between renders.
  const since = new Date(Math.floor(now / HOUR) * HOUR - days * DAY).toISOString();
  const q = useGatewayQuery("audit.friction", { since });
  const data = q.data;
  return (
    <section aria-label={t("friction.title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 px-2">
        <h3 className="text-headline text-label-primary">{t("friction.title")}</h3>
      </div>
      <p className="px-2 text-callout text-label-secondary">{t("friction.hint")}</p>
      <ToggleGroup
        aria-label={t("friction.window")}
        value={[String(days)]}
        onValueChange={(v) => {
          const next = Number(v[0]);
          if (WINDOWS.some((w) => w === next)) setDays(next);
        }}
        className="flex-wrap px-2"
      >
        {WINDOWS.map((w) => (
          <ToggleGroupItem key={w} value={String(w)}>
            {t("friction.window.days", { days: w })}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {q.error && data === undefined ? (
        <div className="flex flex-wrap items-center gap-2 px-2 text-body">
          <p>{t("friction.error", { reason: q.error })}</p>
          <Button variant="ghost" size="sm" onClick={q.reload}>
            {t("friction.retry")}
          </Button>
        </div>
      ) : null}
      {q.loading && data === undefined && !q.error ? (
        <p className="px-2 text-body text-label-secondary">{t("friction.loading")}</p>
      ) : null}
      {data !== undefined && data.decisions === 0 ? (
        <p className="px-2 text-body text-label-secondary">{t("friction.empty")}</p>
      ) : null}
      {data !== undefined && data.decisions > 0 ? (
        <>
          {data.from ? (
            <p className="px-2 text-callout text-label-secondary">
              {t("friction.since", { date: formatDate(data.from) })}
            </p>
          ) : null}
          <FrictionSummary data={data} />
        </>
      ) : null}
    </section>
  );
}
