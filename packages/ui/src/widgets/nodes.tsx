import { WIDGET_LIMITS, type WidgetTone } from "@psyche/protocol";
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { isSafeLink, Markdown } from "../blocks/Markdown.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { SafeLink } from "../links/SafeLink.tsx";
import { BoundNode } from "./bound.tsx";
import { TONE_ICON, TONE_TEXT } from "./tone.ts";

/**
 * Renders widget nodes (generative-ui-2026 §4.2, §10.1). The spec is data and was validated by the
 * Gateway, but the renderer still treats every value as untrusted: strings render as text nodes,
 * `markdown` goes through `Markdown` (no HTML), links through `SafeLink`, and nothing here accepts
 * a class, style or colour from the spec. Interaction nodes (button, choices, form) and the
 * chart, image and map nodes arrive in later phases; until then they show their `fallbackText`.
 */

type N = Record<string, unknown>;
const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const arr = (v: unknown): N[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as N[]) : [];
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const tone = (v: unknown): WidgetTone =>
  v === "info" || v === "success" || v === "warning" || v === "danger" ? v : "neutral";

const GAP: Record<string, string> = {
  none: "gap-0",
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-4",
};
/** At most `columns` columns, fewer on narrow screens. */
const GRID: Record<number, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
};

function ToneMark({ tone: tn }: { tone: WidgetTone }): ReactElement | null {
  if (tn === "neutral") return null;
  const Icon = TONE_ICON[tn];
  return (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t(`widgets.tone.${tn}`)}</span>
    </>
  );
}

const STATE_ICON = {
  todo: Circle,
  active: CircleDot,
  done: CircleCheck,
  skipped: CircleSlash,
  failed: CircleX,
} as const;
type ItemState = keyof typeof STATE_ICON;
const itemState = (v: unknown): ItemState =>
  typeof v === "string" && v in STATE_ICON ? (v as ItemState) : "todo";

function StateMark({ state }: { state: ItemState }): ReactElement {
  const Icon = STATE_ICON[state];
  return (
    <>
      <Icon
        className={cn(
          "size-4 shrink-0",
          state === "done"
            ? "text-success-text"
            : state === "failed"
              ? "text-danger-text"
              : "text-label-secondary",
        )}
        aria-hidden="true"
      />
      <span className="sr-only">{t(`widgets.state.${state}`)}</span>
    </>
  );
}

function Fallback({ node }: { node: N }): ReactElement | null {
  const text = str(node.fallbackText);
  return text ? <p className="text-callout text-label-secondary">{text}</p> : null;
}

function Progress({ n }: { n: N }): ReactElement {
  const label = str(n.label);
  const value = num(n.value);
  const max = num(n.max) ?? 100;
  const indeterminate = n.indeterminate === true || value === undefined;
  const pct = value === undefined ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const steps = arr(n.steps);
  const tn = tone(n.tone);
  const valueText = indeterminate
    ? t("widgets.progress.indeterminate")
    : `${t("widgets.progress.value", { value, max })} · ${t("widgets.progress.percent", { percent: Math.round(pct) })}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-callout">
        <span
          className={cn(
            "inline-flex items-center gap-1 font-medium",
            tn !== "neutral" && TONE_TEXT[tn],
          )}
        >
          <ToneMark tone={tn} />
          {label}
        </span>
        <span className="text-label-secondary tabular-nums" aria-hidden="true">
          {valueText}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        {...(indeterminate ? {} : { "aria-valuemax": max, "aria-valuenow": value })}
        aria-valuetext={valueText}
        className="h-1.5 overflow-hidden rounded-full bg-fill-tertiary"
      >
        <div
          className={cn(
            "h-full rounded-full bg-label-primary transition-[width] duration-300 motion-reduce:transition-none",
            indeterminate && "w-1/3",
          )}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      {steps.length > 0 ? (
        <ol className="mt-1 flex flex-col gap-0.5" aria-label={t("widgets.progress.steps")}>
          {steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps have no ids; the list is positional
            <li key={i} className="flex items-center gap-2 text-callout">
              <StateMark state={itemState(s.state)} />
              <span>{str(s.label)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Checklist({ n }: { n: N }): ReactElement {
  return (
    <ul className="flex flex-col gap-1">
      {arr(n.items).map((i, k) => {
        const state = itemState(i.state);
        return (
          <li key={str(i.id) || k} className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex">
              <StateMark state={state} />
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  state === "done" && "text-label-secondary line-through",
                  state === "skipped" && "text-label-secondary",
                )}
              >
                {str(i.label)}
              </span>
              {i.detail ? (
                <span className="block text-callout text-label-secondary">{str(i.detail)}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Timeline({ n }: { n: N }): ReactElement {
  return (
    <ol className="flex flex-col">
      {arr(n.entries).map((e, k) => {
        const tn = tone(e.tone);
        return (
          <li
            key={str(e.id) || k}
            className="flex gap-3 border-s border-border ps-3 pb-2 last:pb-0"
          >
            <span className="w-16 shrink-0 text-callout text-label-secondary tabular-nums">
              {str(e.time)}
            </span>
            <span
              className={cn(
                "inline-flex min-w-0 items-start gap-1",
                tn !== "neutral" && TONE_TEXT[tn],
              )}
            >
              <ToneMark tone={tn} />
              {str(e.label)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** A link only when the scheme is safe (http, https, mailto, #, same-origin path); else plain text. */
function Link({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return isSafeLink(href) ? <SafeLink href={href}>{children}</SafeLink> : <span>{children}</span>;
}

const CELL_NUM = new Intl.NumberFormat();
function cell(col: N, v: unknown): ReactNode {
  if (v === null || v === undefined) return "";
  if (col.type === "number" && typeof v === "number") return CELL_NUM.format(v);
  if (col.type === "link" && typeof v === "string") return <Link href={v}>{v}</Link>;
  return String(v);
}

function Table({ n }: { n: N }): ReactElement {
  const cols = arr(n.columns);
  const all = arr(n.rows);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => {
    if (!sort) return all;
    return [...all].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
      return String(x ?? "").localeCompare(String(y ?? "")) * sort.dir;
    });
  }, [all, sort]);
  const shown = expanded ? rows : rows.slice(0, WIDGET_LIMITS.tableRowsShown);
  const sortable = n.sortable === true;
  if (all.length === 0)
    return <p className="text-callout text-label-secondary">{t("widgets.table.empty")}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-start text-callout">
          <caption className="sr-only">{str(n.label)}</caption>
          <thead>
            <tr>
              {cols.map((c) => {
                const key = str(c.key);
                const dir = sort?.key === key ? sort.dir : 0;
                return (
                  <th
                    key={key}
                    scope="col"
                    aria-sort={dir === 0 ? undefined : dir === 1 ? "ascending" : "descending"}
                    className={cn(
                      "border-border border-b px-2 py-1 font-medium text-label-secondary",
                      c.type === "number" ? "text-end" : "text-start",
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-label-primary"
                        aria-label={t("widgets.table.sortBy", { column: str(c.label) })}
                        onClick={() => setSort(dir === 1 ? { key, dir: -1 } : { key, dir: 1 })}
                      >
                        {str(c.label)}
                        {dir === 1 ? (
                          <ChevronUp className="size-3" aria-hidden="true" />
                        ) : dir === -1 ? (
                          <ChevronDown className="size-3" aria-hidden="true" />
                        ) : null}
                      </button>
                    ) : (
                      str(c.label)
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no ids
              <tr key={i} className="border-border border-b last:border-b-0">
                {cols.map((c, ci) =>
                  ci === 0 ? (
                    <th key={str(c.key)} scope="row" className="px-2 py-1 text-start font-normal">
                      {cell(c, r[str(c.key)])}
                    </th>
                  ) : (
                    <td
                      key={str(c.key)}
                      className={cn(
                        "px-2 py-1",
                        c.type === "number" ? "text-end tabular-nums" : "text-start",
                      )}
                    >
                      {cell(c, r[str(c.key)])}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {all.length > WIDGET_LIMITS.tableRowsShown ? (
        <button
          type="button"
          className="self-start rounded-md px-1 py-0.5 text-callout text-label-secondary hover:bg-fill-quaternary"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("widgets.table.showFewer")
            : t("widgets.table.showAll", { count: all.length })}
        </button>
      ) : null}
    </div>
  );
}

function Tabs({ n, depth }: { n: N; depth: number }): ReactElement {
  const tabs = arr(n.tabs);
  const base = useId();
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight"
        ? i === last
          ? 0
          : i + 1
        : e.key === "ArrowLeft"
          ? i === 0
            ? last
            : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next === -1) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };
  const current = Math.min(active, tabs.length - 1);
  return (
    <div>
      <div role="tablist" className="flex gap-1 border-border border-b">
        {tabs.map((tab, i) => (
          <button
            key={str(tab.id)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-t-${i}`}
            aria-selected={i === current}
            aria-controls={`${base}-p-${i}`}
            tabIndex={i === current ? 0 : -1}
            className={cn(
              "-mb-px border-b-2 px-2 py-1 text-callout",
              i === current
                ? "border-accent text-label-primary"
                : "border-transparent text-label-secondary hover:text-label-primary",
            )}
            onClick={() => setActive(i)}
            onKeyDown={(e) => move(e, i)}
          >
            {str(tab.label)}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div
          key={str(tab.id)}
          role="tabpanel"
          id={`${base}-p-${i}`}
          aria-labelledby={`${base}-t-${i}`}
          hidden={i !== current}
          className="pt-2"
        >
          {i === current ? (
            <Children list={arr(tab.children)} depth={depth + 1} className="flex flex-col gap-2" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Children({
  list,
  depth,
  className,
  style,
}: {
  list: N[];
  depth: number;
  className: string;
  style?: CSSProperties;
}): ReactElement {
  return (
    <div className={className} style={style}>
      {list.map((c, i) => (
        <RenderNode key={str(c.id) || i} node={c} depth={depth} />
      ))}
    </div>
  );
}

/** Pre-render guard: the Gateway already caps depth at 8, the client does not trust that. */
const MAX_DEPTH = WIDGET_LIMITS.depth + 2;

export function RenderNode({ node, depth }: { node: N; depth: number }): ReactElement | null {
  if (depth > MAX_DEPTH) return null;
  // A bound node is drawn from a live entity; the bound renderer calls back here with props merged.
  if (node.bind && typeof node.bind === "object") return <BoundNode node={node} depth={depth} />;
  const n = node;
  switch (n.type) {
    case "stack":
      return (
        <Children
          list={arr(n.children)}
          depth={depth + 1}
          className={cn(
            "flex",
            n.direction === "horizontal" ? "flex-row flex-wrap items-start" : "flex-col",
            GAP[str(n.gap)] ?? "gap-2",
          )}
        />
      );
    case "grid": {
      const cols = Math.min(4, Math.max(2, num(n.columns) ?? 2));
      return (
        <Children
          list={arr(n.children)}
          depth={depth + 1}
          className={cn("grid", GRID[cols], GAP[str(n.gap)] ?? "gap-3")}
        />
      );
    }
    case "tabs":
      return <Tabs n={n} depth={depth} />;
    case "card": {
      const tn = tone(n.tone);
      return (
        <section
          className={cn(
            "rounded-md border bg-gray-2 p-2.5",
            tn === "neutral" ? "border-border" : "border-separator-strong",
          )}
          aria-label={str(n.title) || undefined}
        >
          {n.title ? (
            <h4
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                TONE_TEXT[tn] === TONE_TEXT.neutral ? "text-label-primary" : TONE_TEXT[tn],
              )}
            >
              <ToneMark tone={tn} />
              {str(n.title)}
            </h4>
          ) : null}
          {n.subtitle ? (
            <p className="text-callout text-label-secondary">{str(n.subtitle)}</p>
          ) : null}
          <Children
            list={arr(n.children)}
            depth={depth + 1}
            className="mt-1.5 flex flex-col gap-2"
          />
        </section>
      );
    }
    case "list": {
      const items = arr(n.items);
      if (items.length === 0)
        return <p className="text-callout text-label-secondary">{t("widgets.list.empty")}</p>;
      return (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((i, k) => (
            <li key={str(i.id) || k} className="flex items-baseline justify-between gap-3 py-1">
              <span className="min-w-0">{str(i.title)}</span>
              {i.meta ? (
                <span className="shrink-0 text-callout text-label-secondary">{str(i.meta)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      );
    }
    case "progress":
      return <Progress n={n} />;
    case "checklist":
      return <Checklist n={n} />;
    case "timeline":
      return <Timeline n={n} />;
    case "status": {
      const tn = tone(n.tone);
      return (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-callout",
            TONE_TEXT[tn] === TONE_TEXT.neutral ? "text-label-primary" : TONE_TEXT[tn],
          )}
        >
          <ToneMark tone={tn} />
          {str(n.label)}
        </span>
      );
    }
    case "stat": {
      const tn = tone(n.tone);
      return (
        <div className="flex flex-col">
          <span className="text-callout text-label-secondary">{str(n.label)}</span>
          <span
            className={cn(
              "font-semibold text-title tabular-nums",
              tn !== "neutral" && TONE_TEXT[tn],
            )}
          >
            {typeof n.value === "number" ? CELL_NUM.format(n.value) : str(n.value)}
            {n.unit ? (
              <span className="ms-1 font-normal text-callout text-label-secondary">
                {str(n.unit)}
              </span>
            ) : null}
          </span>
          {n.delta ? (
            <span className="text-callout text-label-secondary">
              <span className="sr-only">{t("widgets.stat.delta", { delta: "" })}</span>
              {str(n.delta)}
            </span>
          ) : null}
        </div>
      );
    }
    case "kv":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
          {arr(n.rows).map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no ids
            <div key={i} className="contents">
              <dt className="text-callout text-label-secondary">{str(r.label)}</dt>
              <dd>{str(r.value)}</dd>
            </div>
          ))}
        </dl>
      );
    case "table":
      return <Table n={n} />;
    case "text": {
      const tn = tone(n.tone);
      return (
        <p
          className={cn(
            "whitespace-pre-wrap",
            n.emphasis === "strong" && "font-semibold",
            tn !== "neutral" && TONE_TEXT[tn],
          )}
        >
          {str(n.text)}
        </p>
      );
    }
    case "markdown":
      return <Markdown>{str(n.md)}</Markdown>;
    case "code": {
      const code = str(n.code);
      const fence = "`".repeat(
        Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)),
      );
      return (
        <div>
          <Markdown>{`${fence}${str(n.language).replace(/[^a-z0-9+#-]/gi, "")}\n${code}\n${fence}`}</Markdown>
        </div>
      );
    }
    case "link":
      return <Link href={str(n.url)}>{str(n.label)}</Link>;
    default:
      return <Fallback node={n} />;
  }
}
