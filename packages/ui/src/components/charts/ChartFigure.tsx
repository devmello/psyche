import { type ReactElement, type ReactNode, useId } from "react";
import { cn } from "../../lib/utils.ts";
import type { DataTable } from "./describe.ts";

export interface ChartFigureProps {
  /** The chart's name (the figure's accessible name and the hidden table's caption). */
  label: string;
  /** The facts line under the chart ("Busiest day: Oct 14 · 23 runs"); the figcaption. */
  caption?: ReactNode;
  /** The data behind the picture, visually hidden. */
  table: DataTable;
  /** Keyboard help, read after the label by the focusable marks (`aria-describedby`). */
  hint?: string;
  /** Receives the id of the hint to put on the chart group. */
  children: (hintId: string | undefined) => ReactNode;
  className?: string;
  testId?: string;
}

/**
 * A chart as a `figure` (agent-overview-2026 §5.7): the picture, a figcaption with the facts
 * line, and a visually hidden data table so the numbers are readable without the marks.
 */
export function ChartFigure({
  label,
  caption,
  table,
  hint,
  children,
  className,
  testId,
}: ChartFigureProps): ReactElement {
  const hintId = useId();
  return (
    <figure aria-label={label} className={cn("m-0", className)} data-testid={testId}>
      {children(hint === undefined ? undefined : hintId)}
      {hint === undefined ? null : (
        <p id={hintId} className="sr-only">
          {hint}
        </p>
      )}
      {caption === undefined ? null : (
        <figcaption className="mt-2 text-callout text-label-secondary">{caption}</figcaption>
      )}
      <table className="sr-only" aria-label={label}>
        <thead>
          <tr>
            {table.head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={table.head[i]} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={table.head[i]}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
