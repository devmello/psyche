import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import {
  type ColumnFilter,
  cellRef,
  columnLetter,
  columnStats,
  filterRows,
  parseFilter,
  parseWorkbook,
  type SheetData,
  type WorkbookData,
} from "../core/sheet.ts";
import type { ViewerProps } from "./contract.ts";
import { canEditSheet, SheetEditor } from "./SheetEditor.tsx";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

const ROW_HEIGHT = 28;
const COL_WIDTH = 140;
const features = tableFeatures({});
/** A grid row is an index into the parsed sheet (TanStack rows must be objects). */
type RowRef = { i: number };
const helper = createColumnHelper<typeof features, RowRef>();

/**
 * Spreadsheet viewer (P3): SheetJS CE parsing, sheet tabs, a virtualized TanStack Table grid,
 * per-column filters and stats, CSV/TSV. Rows are indexes into the parsed sheet, so filtering a
 * 50k-row file never copies the data.
 */
export function SheetViewer(props: ViewerProps) {
  const [editing, setEditing] = useState(false);
  // Bumped when the editor closes so the grid re-reads the saved file.
  const [revision, setRevision] = useState(0);
  if (editing)
    return (
      <SheetEditor
        {...props}
        onClose={() => {
          setEditing(false);
          setRevision((r) => r + 1);
        }}
      />
    );
  return (
    <SheetGrid
      key={revision}
      {...props}
      onEdit={canEditSheet(props) ? () => setEditing(true) : undefined}
    />
  );
}

function SheetGrid(props: ViewerProps & { onEdit: (() => void) | undefined }) {
  const state = useLoadable(props.item.id, async (signal) =>
    parseWorkbook(await props.load(signal), props.item.name),
  );
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This spreadsheet could not be opened"
        detail={state.error.message}
      />
    );
  if (state.value.sheets.length === 0)
    return <ViewerMessage kind="empty" title="This workbook has no sheets" />;
  return <Workbook {...props} wb={state.value} />;
}

function Workbook(props: ViewerProps & { wb: WorkbookData; onEdit: (() => void) | undefined }) {
  const names = props.wb.sheets.map((s) => s.name);
  const initial =
    props.pageState?.sheet !== undefined && names.includes(props.pageState.sheet)
      ? props.pageState.sheet
      : names[0];
  const [active, setActive] = useState(initial);
  const sheet = props.wb.sheets.find((s) => s.name === active) ?? props.wb.sheets[0];
  if (sheet === undefined) return null;
  return (
    <div className="psy-sheet">
      {names.length > 1 ? (
        <div className="psy-sheet__tabs" role="tablist" aria-label="Sheets">
          {names.map((n) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={n === sheet.name}
              onClick={() => {
                setActive(n);
                props.onPageStateChange?.({ sheet: n });
              }}
            >
              {n}
            </button>
          ))}
        </div>
      ) : null}
      <Grid key={sheet.name} {...props} sheet={sheet} />
    </div>
  );
}

function Grid(props: ViewerProps & { sheet: SheetData; onEdit: (() => void) | undefined }) {
  const { sheet } = props;
  const [filterText, setFilterText] = useState<Record<number, string>>({});
  const [statsCol, setStatsCol] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filters = useMemo(() => {
    const m = new Map<number, ColumnFilter>();
    for (const [col, text] of Object.entries(filterText)) {
      const f = parseFilter(text);
      if (f !== undefined) m.set(Number(col), f);
    }
    return m;
  }, [filterText]);

  const indexes = useMemo(
    () => (filters.size === 0 ? sheet.rows.map((_, i) => i) : filterRows(sheet.rows, filters)),
    [sheet, filters],
  );
  const data = useMemo<RowRef[]>(() => indexes.map((i) => ({ i })), [indexes]);

  const columns = useMemo(
    () =>
      helper.columns(
        Array.from({ length: sheet.columnCount }, (_, c) =>
          helper.accessor((r: RowRef) => sheet.rows[r.i]?.[c] ?? "", {
            id: String(c),
            header: sheet.header?.[c] ?? columnLetter(c),
          }),
        ),
      ),
    [sheet],
  );

  const table = useTable({ features, columns, data });
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    // jsdom and first paint: assume a pane-sized viewport until measured.
    initialRect: { width: 960, height: 600 },
  });

  const stats = useMemo(
    () => (statsCol === null ? null : columnStats(sheet.rows, statsCol, indexes)),
    [statsCol, sheet, indexes],
  );
  const width = sheet.columnCount * COL_WIDTH + 56;

  return (
    <div className="psy-sheet__grid">
      <Toolbar label="Spreadsheet">
        <span aria-live="polite">
          {data.length === sheet.rows.length
            ? `${sheet.rows.length.toLocaleString()} rows`
            : `${data.length.toLocaleString()} of ${sheet.rows.length.toLocaleString()} rows`}
        </span>
        {sheet.truncated ? (
          <span role="note">Showing the first {sheet.rows.length.toLocaleString()} rows</span>
        ) : null}
        {filters.size > 0 ? (
          <button type="button" onClick={() => setFilterText({})}>
            Clear filters
          </button>
        ) : null}
        {props.onEdit ? (
          <button type="button" onClick={props.onEdit}>
            Edit
          </button>
        ) : null}
        {props.onSendToChat ? (
          <button
            type="button"
            onClick={() => props.onSendToChat?.({ itemId: props.item.id, name: props.item.name })}
          >
            Send to chat
          </button>
        ) : null}
      </Toolbar>
      <div
        ref={scrollRef}
        className="psy-sheet__scroll"
        style={{ overflow: "auto", height: "100%", minHeight: 200 }}
        data-testid="sheet-scroll"
      >
        <table
          className="psy-sheet__table"
          aria-rowcount={data.length + 1}
          aria-colcount={sheet.columnCount}
          style={{ width, display: "grid", borderCollapse: "collapse" }}
        >
          <thead style={{ display: "grid", position: "sticky", top: 0, zIndex: 1 }}>
            <tr className="psy-sheet__head" style={{ display: "flex" }}>
              <th style={{ width: 56 }}>
                <span className="psy-visually-hidden">Row</span>
              </th>
              {table.getHeaderGroups()[0]?.headers.map((h) => {
                const c = Number(h.column.id);
                return (
                  <th key={h.id} style={{ width: COL_WIDTH }} aria-colindex={c + 1}>
                    <button
                      type="button"
                      className="psy-sheet__colname"
                      onClick={() => setStatsCol(statsCol === c ? null : c)}
                      aria-pressed={statsCol === c}
                      title="Column stats"
                    >
                      <small>{columnLetter(c)}</small> <table.FlexRender header={h} />
                    </button>
                    <input
                      aria-label={`Filter ${sheet.header?.[c] ?? columnLetter(c)}`}
                      placeholder="Filter"
                      value={filterText[c] ?? ""}
                      onChange={(e) => setFilterText({ ...filterText, [c]: e.target.value })}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody
            style={{ display: "grid", height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (row === undefined) return null;
              const dataIndex = row.original.i;
              return (
                <tr
                  key={row.id}
                  aria-rowindex={vi.index + 2}
                  style={{
                    display: "flex",
                    position: "absolute",
                    top: 0,
                    transform: `translateY(${vi.start}px)`,
                    height: ROW_HEIGHT,
                  }}
                >
                  <th scope="row" style={{ width: 56 }}>
                    {cellRef(sheet, dataIndex, 0).replace(/^[A-Z]+/, "")}
                  </th>
                  {row.getAllCells().map((cell) => {
                    const c = Number(cell.column.id);
                    const text = String(cell.getValue() ?? "");
                    return (
                      <td
                        key={cell.id}
                        tabIndex={-1}
                        style={{
                          width: COL_WIDTH,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={text}
                        onFocus={() =>
                          props.onSelectionChange?.({
                            kind: "cells",
                            sheet: sheet.name,
                            range: cellRef(sheet, dataIndex, c),
                            text: text.slice(0, 4000),
                          })
                        }
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {stats === null || statsCol === null ? null : (
        <aside
          className="psy-sheet__stats"
          aria-label={`Stats for ${sheet.header?.[statsCol] ?? columnLetter(statsCol)}`}
        >
          <dl>
            <dt>Type</dt>
            <dd>{stats.type}</dd>
            <dt>Rows</dt>
            <dd>{stats.count.toLocaleString()}</dd>
            <dt>Empty</dt>
            <dd>{stats.empty.toLocaleString()}</dd>
            <dt>Distinct</dt>
            <dd>
              {stats.distinct.toLocaleString()}
              {stats.distinctCapped ? "+" : ""}
            </dd>
            {stats.sum === undefined ? null : (
              <>
                <dt>Sum</dt>
                <dd>{fmt(stats.sum)}</dd>
                <dt>Mean</dt>
                <dd>{fmt(stats.mean ?? 0)}</dd>
                <dt>Min</dt>
                <dd>{fmt(stats.min ?? 0)}</dd>
                <dt>Max</dt>
                <dd>{fmt(stats.max ?? 0)}</dd>
              </>
            )}
          </dl>
        </aside>
      )}
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
