import type { ReactElement, ReactNode } from "react";

/**
 * The hover/focus tooltip for one mark. It sits above the mark, is not announced (the mark's
 * own `aria-label` already says everything), and never takes the pointer.
 */
export function ChartTooltip({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: readonly { color?: string; label: string; value: string }[];
  footer?: ReactNode;
}): ReactElement {
  return (
    <div
      aria-hidden="true"
      data-chart-tooltip=""
      className="pointer-events-none absolute bottom-full start-1/2 z-20 mb-2 min-w-36 -translate-x-1/2 rounded-lg bg-surface-overlay p-2 text-caption text-label-primary shadow-elevation-2 rtl:translate-x-1/2"
    >
      <div className="font-semibold">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="mt-1 flex items-center gap-2">
          {r.color ? (
            <span className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
          ) : null}
          <span className="flex-1 text-label-secondary">{r.label}</span>
          <span className="tabular-nums">{r.value}</span>
        </div>
      ))}
      {footer ? <div className="mt-1 text-label-secondary">{footer}</div> : null}
    </div>
  );
}
