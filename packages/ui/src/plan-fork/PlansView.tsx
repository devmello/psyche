import type {
  ForkCite,
  ForkReport,
  PlanComparison,
  PlanFork,
  PlanForkBranch,
} from "@psyche/protocol";
import { ArrowLeft } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { usePlanFork } from "./data.ts";
import { branchLine, totalText } from "./ForkCard.tsx";
import { canTake, costTotals, earliestDeadline, formatMoney, formatUsd, isLive } from "./model.ts";
import { TakeSheet } from "./TakeSheet.tsx";

/** Below this container width the lanes become tabs (§5.1). */
export const NARROW_PX = 720;

/** Tracks the width of an element; 0 until measured (and in jsdom). */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el == null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Tag({ children, title }: { children: ReactNode; title?: string }): ReactElement {
  return (
    <span
      title={title}
      className="rounded-xs bg-fill-quaternary px-1.5 py-0.5 text-footnote text-label-secondary"
    >
      {children}
    </span>
  );
}

const SOURCE_LABEL = {
  memory: "planFork.source.memory",
  mail: "planFork.source.mail",
  calendar: "planFork.source.calendar",
  contacts: "planFork.source.contacts",
  messages: "planFork.source.messages",
  web: "planFork.source.web",
  files: "planFork.source.files",
} as const satisfies Record<NonNullable<ForkCite["source"]>, string>;

/** A source chip: it opens the fact, mail, event or page the item cites. */
function Chips({
  cites,
  onOpenCite,
}: {
  cites: readonly ForkCite[];
  onOpenCite?: (cite: ForkCite) => void;
}): ReactElement | null {
  const seen = new Set<string>();
  const shown = cites.filter((c) => c.source !== undefined && !seen.has(c.ref) && seen.add(c.ref));
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((c) => {
        const name = t(SOURCE_LABEL[c.source ?? "web"]);
        const web = c.source === "web" && /^https?:\/\//.test(c.ref);
        return web ? (
          <a
            key={c.ref}
            href={c.ref}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-xs bg-fill-quaternary px-1.5 py-0.5 text-footnote text-label-secondary hover:text-label-primary"
          >
            {name}
          </a>
        ) : (
          <button
            key={c.ref}
            type="button"
            disabled={onOpenCite === undefined}
            onClick={() => onOpenCite?.(c)}
            className="cursor-default rounded-xs bg-fill-quaternary px-1.5 py-0.5 text-footnote text-label-secondary enabled:hover:text-label-primary"
          >
            {name}
          </button>
        );
      })}
    </span>
  );
}

interface ItemView {
  id: string;
  text: ReactNode;
  cites: readonly ForkCite[];
  estimate?: boolean;
  basis?: string | undefined;
  unsourced?: boolean | undefined;
}

/** The items a comparison row points at, drawn from the branch's own report. */
function itemsFor(
  dimension: PlanComparison["rows"][number]["dimension"],
  r: ForkReport,
  ids: readonly string[],
): ItemView[] {
  const want = new Set(ids);
  switch (dimension) {
    case "cost":
      return r.costs
        .filter((c) => want.has(c.id))
        .map((c) => ({
          id: c.id,
          text: `${c.label}: ${formatMoney(c.amount, c.currency)} ${t(`planFork.period.${c.period}`)}`,
          cites: c.cites,
          estimate: c.estimate,
          basis: c.basis,
          unsourced: c.unsourced,
        }));
    case "dates":
      return r.dates
        .filter((d) => want.has(d.id))
        .map((d) => ({
          id: d.id,
          text: `${d.label}: ${d.date.slice(0, 10)}`,
          cites: d.cites,
          estimate: d.estimate,
          unsourced: d.unsourced,
        }));
    case "people":
      return r.people
        .filter((p) => want.has(p.id))
        .map((p) => ({
          id: p.id,
          text: `${p.name}: ${p.effect}`,
          cites: p.cites,
          unsourced: p.unsourced,
        }));
    case "tradeoffs":
      return r.tradeoffs
        .filter((x) => want.has(x.id))
        .map((x) => ({
          id: x.id,
          text:
            x.gain === undefined
              ? x.giveUp
              : t("planFork.tradeoff", { gain: x.gain, giveUp: x.giveUp }),
          cites: x.cites,
          unsourced: x.unsourced,
        }));
    case "risks":
      return r.risks
        .filter((x) => want.has(x.id))
        .map((x) => ({ id: x.id, text: x.text, cites: x.cites, unsourced: x.unsourced }));
    case "open":
      return r.openQuestions
        .filter((x) => want.has(x.id))
        .map((x) => ({ id: x.id, text: x.text, cites: [] }));
  }
}

function Item({
  item,
  onOpenCite,
}: {
  item: ItemView;
  onOpenCite?: (c: ForkCite) => void;
}): ReactElement {
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-callout text-label-primary">
      <span>{item.text}</span>
      {item.estimate === true ? <Tag title={item.basis}>{t("planFork.estimate")}</Tag> : null}
      {item.unsourced === true ? <Tag>{t("planFork.noSource")}</Tag> : null}
      <Chips cites={item.cites} {...(onOpenCite ? { onOpenCite } : {})} />
    </li>
  );
}

/** The comparison: one row per dimension, one cell per branch. Differing rows show by default. */
export function Comparison({
  fork,
  branches,
  onOpenCite,
}: {
  fork: PlanFork;
  branches: PlanForkBranch[];
  onOpenCite?: (c: ForkCite) => void;
}): ReactElement {
  const [all, setAll] = useState(false);
  const comparison = fork.comparison;
  const textHidden = branches.some((b) => b.scrub?.textHidden === true);
  const rows = (comparison?.rows ?? []).filter((r) => all || r.differs);
  const hiddenRows = (comparison?.rows.length ?? 0) - rows.length;
  const reported = branches.filter((b) => b.report != null);
  return (
    <section
      aria-label={t("planFork.compare.aria")}
      data-testid="plan-compare"
      className="flex flex-col gap-3"
    >
      {comparison != null ? (
        <h3 className="m-0 text-body font-medium text-label-primary">
          {textHidden ? t("planFork.hiddenText") : comparison.headline}
        </h3>
      ) : (
        <p className="m-0 text-callout text-label-secondary">{t("planFork.compare.none")}</p>
      )}
      <table
        className="w-full table-fixed border-collapse text-start text-callout"
        aria-label={t("planFork.compare.aria")}
      >
        <thead>
          <tr className="border-b border-separator text-label-secondary">
            <td className="w-32 py-1" />
            {branches.map((b) => (
              <th key={b.id} scope="col" className="py-1 pe-3 text-start font-medium">
                {b.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Totals and deadlines come from the reports in code, never from the model's notes. */}
          <tr className="border-b border-separator align-top">
            <th scope="row" className="py-2 pe-3 text-start font-normal text-label-secondary">
              {t("planFork.row.totals")}
            </th>
            {branches.map((b) => {
              const totals = b.report == null ? [] : costTotals(b.report.costs);
              return (
                <td
                  key={b.id}
                  className="py-2 pe-3 text-label-primary"
                  data-testid={`total-${b.id}`}
                >
                  {b.scrub?.totalsHidden === true
                    ? t("planFork.totalOnMac")
                    : totals.length === 0
                      ? t("planFork.total.none")
                      : totals.map((x) => (
                          <span key={`${x.currency}${x.period}`} className="block">
                            {totalText(x)}
                          </span>
                        ))}
                </td>
              );
            })}
          </tr>
          <tr className="border-b border-separator align-top">
            <th scope="row" className="py-2 pe-3 text-start font-normal text-label-secondary">
              {t("planFork.row.deadline")}
            </th>
            {branches.map((b) => {
              const d = b.report == null ? null : earliestDeadline(b.report);
              return (
                <td key={b.id} className="py-2 pe-3 text-label-primary">
                  {d == null ? t("planFork.deadline.none") : `${d.label}: ${d.date.slice(0, 10)}`}
                  {d?.estimate === true ? (
                    <>
                      {" "}
                      <Tag>{t("planFork.estimate")}</Tag>
                    </>
                  ) : null}
                </td>
              );
            })}
          </tr>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no ids
            <tr key={i} className="border-b border-separator align-top">
              <th scope="row" className="py-2 pe-3 text-start font-normal text-label-secondary">
                {row.label}
              </th>
              {branches.map((b) => {
                const cell = row.cells.find((c) => c.branchId === b.id);
                const items =
                  b.report == null || cell === undefined
                    ? []
                    : itemsFor(row.dimension, b.report, cell.itemIds);
                return (
                  <td key={b.id} className="py-2 pe-3">
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {items.map((it) => (
                        <Item key={it.id} item={it} {...(onOpenCite ? { onOpenCite } : {})} />
                      ))}
                    </ul>
                    {b.scrub !== undefined &&
                    b.scrub.hiddenItems > 0 &&
                    row.dimension === "cost" ? (
                      <span className="block text-label-secondary">
                        {t("planFork.moreOnMac", { count: b.scrub.hiddenItems })}
                      </span>
                    ) : null}
                    {cell?.note !== undefined ? (
                      <span className="block text-label-secondary">
                        {textHidden ? t("planFork.hiddenText") : cell.note}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {comparison != null && (hiddenRows > 0 || all) ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll((v) => !v)}>
          {all ? t("planFork.compare.onlyDiffer") : t("planFork.compare.showAll")}
        </Button>
      ) : null}
      {comparison != null && comparison.betterIf.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-callout text-label-secondary">
          {reported.map((b) => {
            const better = comparison.betterIf.find((x) => x.branchId === b.id);
            return better === undefined ? null : (
              <li key={b.id}>
                <span className="font-medium text-label-primary">{b.label}</span>{" "}
                {textHidden ? t("planFork.hiddenText") : better.text}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** One lane: a branch's summary, steps, open questions and its Take button. */
export function Lane({
  fork,
  branch,
  step,
  onTake,
  onOpenTranscript,
  onRetry,
  onCancel,
}: {
  fork: PlanFork;
  branch: PlanForkBranch;
  step?: string | undefined;
  onTake: () => void;
  onOpenTranscript?: ((threadId: string) => void) | undefined;
  onRetry: () => void;
  onCancel: () => void;
}): ReactElement {
  const r = branch.report;
  const hidden = branch.scrub?.textHidden === true;
  return (
    <article
      aria-label={branch.label}
      data-testid={`lane-${branch.id}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-separator bg-surface-raised p-4"
    >
      <header className="flex flex-col gap-0.5">
        <h3 className="m-0 text-body font-medium text-label-primary">{branch.label}</h3>
        <p className="m-0 text-callout text-label-secondary">{branch.premise}</p>
      </header>
      {r == null ? (
        <p className="m-0 text-callout text-label-secondary">{branchLine(branch, step)}</p>
      ) : (
        <>
          <p className="m-0 text-callout text-label-primary">
            {hidden ? t("planFork.hiddenText") : r.summary}
          </p>
          {r.steps.length > 0 ? (
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-callout">
              {r.steps.map((s) => (
                <li key={s.id} className="flex flex-col">
                  <span className="text-label-primary">
                    {s.text} {s.stagedId !== undefined ? <Tag>{t("planFork.prepared")}</Tag> : null}
                  </span>
                  <span className="text-footnote text-label-secondary">
                    {s.stagedId !== undefined
                      ? ""
                      : s.who === "psyche"
                        ? t("planFork.psycheDoes")
                        : t("planFork.youDo")}
                    {s.when !== undefined ? ` ${s.when}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {r.openQuestions.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h4 className="m-0 text-subheadline font-medium text-label-secondary">
                {t("planFork.needsOk")}
              </h4>
              <ul className="m-0 list-none p-0 text-callout text-label-primary">
                {r.openQuestions.map((q) => (
                  <li key={q.id}>{q.text}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        {onOpenTranscript !== undefined ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenTranscript(branch.threadId)}>
            {t("planFork.openTranscript")}
          </Button>
        ) : (
          <span />
        )}
        {branch.status === "failed" && fork.status !== "taken" ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("planFork.retryBranch")}
          </Button>
        ) : null}
        {branch.status === "running" || branch.status === "queued" ? (
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t("planFork.cancel")}
          </Button>
        ) : null}
        {fork.status === "ready" || fork.status === "taken" ? (
          <Button
            size="sm"
            disabled={!canTake(fork.status, branch)}
            onClick={onTake}
            aria-label={t("planFork.takeAria", { label: branch.label })}
          >
            {t("planFork.take")}
          </Button>
        ) : null}
      </footer>
    </article>
  );
}

export interface PlansViewProps {
  forkId: string;
  onBack: () => void;
  /** Opens a branch's read-only transcript. */
  onOpenTranscript?: (threadId: string) => void;
  onOpenCite?: (cite: ForkCite) => void;
  /** Forces a layout (tests, stories); by default the container's width decides. */
  layout?: "auto" | "tabs" | "columns";
  onTaken?: () => void;
}

/**
 * The Plans view (§5.1): opens in the chat pane in place of the transcript, with Back. Lanes (one
 * column per branch, tabs on a narrow pane), then the comparison. Take this plan is the view's one
 * accent control, at the foot of each lane.
 */
export function PlansView({
  forkId,
  onBack,
  onOpenTranscript,
  onOpenCite,
  layout = "auto",
  onTaken,
}: PlansViewProps): ReactElement {
  const { fork, branches, steps, loading, error, reload } = usePlanFork(forkId);
  const call = useCall();
  const [ref, width] = useWidth();
  const [taking, setTaking] = useState<string | null>(null);
  const tabs = layout === "tabs" || (layout === "auto" && width > 0 && width < NARROW_PX);
  const takeBranch = branches.find((b) => b.id === taking) ?? null;
  const act = (m: "cancel" | "retry", branchId: string) => {
    const done = () => reload();
    (m === "cancel"
      ? call("planForks.cancel", { forkId, branchId })
      : call("planForks.retryBranch", { forkId, branchId })
    )
      .then(done)
      .catch(() => {});
  };
  const lane = (b: PlanForkBranch) =>
    fork == null ? null : (
      <Lane
        key={b.id}
        fork={fork}
        branch={b}
        step={steps[b.id]}
        onTake={() => setTaking(b.id)}
        onOpenTranscript={onOpenTranscript}
        onRetry={() => act("retry", b.id)}
        onCancel={() => act("cancel", b.id)}
      />
    );
  return (
    <div
      ref={ref}
      data-testid="plans-view"
      data-layout={tabs ? "tabs" : "columns"}
      className="@container/plans flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-canvas px-4 py-4 @xl/chat:px-6"
    >
      <div className="mx-auto flex w-full max-w-(--chat-wide) flex-col gap-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="rtl:-scale-x-100" aria-hidden="true" /> {t("planFork.back")}
          </Button>
          <h2 className="m-0 min-w-0 flex-1 truncate text-title-3 font-medium text-label-primary">
            {t("planFork.title")}
          </h2>
          {fork != null ? (
            <span className="text-callout text-label-secondary tabular-nums">
              {isLive(fork.status)
                ? t("planFork.card.spend", {
                    spent: formatUsd(fork.spentUsd),
                    cap: formatUsd(fork.budgetUsd),
                  })
                : t(`planFork.status.${fork.status}`)}
            </span>
          ) : null}
        </div>
        {fork == null ? (
          <p className="m-0 text-callout text-label-secondary" role={error ? "alert" : "status"}>
            {loading ? t("planFork.card.loading") : t("planFork.card.unavailable")}
          </p>
        ) : tabs ? (
          <Tabs defaultValue="compare">
            <TabsList aria-label={t("planFork.tabs.aria")}>
              <TabsTrigger value="compare">{t("planFork.compare")}</TabsTrigger>
              {branches.map((b) => (
                <TabsTrigger key={b.id} value={b.id}>
                  {b.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="compare">
              <Comparison fork={fork} branches={branches} {...(onOpenCite ? { onOpenCite } : {})} />
            </TabsContent>
            {branches.map((b) => (
              <TabsContent key={b.id} value={b.id}>
                {lane(b)}
              </TabsContent>
            ))}
          </Tabs>
        ) : (
          <>
            <div
              className={cn("grid gap-3")}
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, branches.length)}, minmax(0, 1fr))`,
              }}
            >
              {branches.map(lane)}
            </div>
            <Comparison fork={fork} branches={branches} {...(onOpenCite ? { onOpenCite } : {})} />
          </>
        )}
      </div>
      {fork != null && takeBranch != null ? (
        <TakeSheet
          fork={fork}
          branch={takeBranch}
          open
          onOpenChange={(o) => !o && setTaking(null)}
          onDone={() => {
            setTaking(null);
            reload();
            onTaken?.();
          }}
        />
      ) : null}
    </div>
  );
}
