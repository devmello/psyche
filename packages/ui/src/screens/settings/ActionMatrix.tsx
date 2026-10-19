import type { Connector } from "@psyche/protocol";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { type ReactElement, useId, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";

/**
 * Per-connector action matrix, Allow / Ask / Deny per action (UI design §3.18, as on Muse's
 * Notion connector screen), built on TanStack Table v9 (`useTable` + `table.FlexRender`). Each
 * row is a native radio group, so arrow keys move between the three rules.
 */

export type ActionRule = Connector["actionMatrix"][string];

export const RULES: readonly { value: ActionRule; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "deny", label: "Deny" },
];

interface MatrixRow {
  action: string;
  rule: ActionRule;
}

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, MatrixRow>();

/** `mcp__notion__search` stays as written; built-in actions read as `gmail.send`. */
export function isMcpKey(action: string): boolean {
  return /^mcp__[^_]+(?:_[^_]+)*__.+$/.test(action);
}

export interface ActionMatrixProps {
  connectorLabel: string;
  matrix: Readonly<Record<string, ActionRule>>;
  onChange: (action: string, rule: ActionRule) => void;
  disabled?: boolean;
}

export function ActionMatrix({
  connectorLabel,
  matrix,
  onChange,
  disabled = false,
}: ActionMatrixProps): ReactElement {
  const name = useId();
  const data = useMemo<MatrixRow[]>(
    () => Object.entries(matrix).map(([action, rule]) => ({ action, rule })),
    [matrix],
  );
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("action", {
          header: "Action",
          cell: (info) => <code className="font-mono text-xs">{info.getValue()}</code>,
        }),
        ...RULES.map((r) =>
          helper.display({
            id: r.value,
            header: r.label,
            cell: ({ row }) => (
              <input
                type="radio"
                name={`${name}-${row.original.action}`}
                value={r.value}
                checked={row.original.rule === r.value}
                disabled={disabled}
                onChange={() => onChange(row.original.action, r.value)}
                aria-label={`${r.label} ${row.original.action}`}
                className="size-4 accent-accent-9"
              />
            ),
          }),
        ),
      ]),
    [name, disabled, onChange],
  );
  const table = useTable({ features, columns, data });

  return (
    <Table aria-label={`${connectorLabel} actions`}>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead
                key={header.id}
                scope="col"
                className={header.column.id === "action" ? "" : "w-16 text-center"}
              >
                {header.isPlaceholder ? null : <table.FlexRender header={header} />}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} data-rule={row.original.rule}>
            {row.getAllCells().map((cell) =>
              cell.column.id === "action" ? (
                <th key={cell.id} scope="row" className="p-2 text-left font-normal">
                  <table.FlexRender cell={cell} />
                </th>
              ) : (
                <TableCell key={cell.id} className="text-center">
                  <table.FlexRender cell={cell} />
                </TableCell>
              ),
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
