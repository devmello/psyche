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
 * Notion connector screen), built on TanStack Table v9 (`useTable` + `table.FlexRender`). Rows say
 * the action in plain words first and show the raw key (`gmail.send`, `mcp__notion__search`)
 * small and muted beside it. Each row is a native radio group, so arrow keys move between rules.
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

/** Plain-language names for built-in connector actions (§3.18: "read threads", "send"). */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  "gmail.read": "read threads",
  "gmail.send": "send",
  "gmail.draft": "write drafts",
  "gmail.delete": "delete",
  "gmail.label": "label and archive",
  "calendar.read": "read events",
  "calendar.write": "create and change events",
  "calendar.delete": "delete events",
  "contacts.read": "read contacts",
  "drive.read": "read files",
  "drive.write": "create and change files",
};

const VERB: Readonly<Record<string, string>> = { read: "read", write: "change", delete: "delete" };

/**
 * What a row says first: "read threads" for `gmail.read`, "create page" for
 * `mcp__notion__create_page`. The raw key stays beside it at disclosure level 2 (§4.12).
 */
export function actionLabel(action: string): string {
  const known = ACTION_LABEL[action];
  if (known !== undefined) return known;
  if (isMcpKey(action)) return (action.split("__").pop() ?? action).replaceAll("_", " ");
  const [family = action, verb] = action.split(".");
  if (verb === undefined) return action.replaceAll("_", " ");
  return `${VERB[verb] ?? verb.replaceAll("_", " ")} ${family.replaceAll("_", " ")}`;
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
        helper.display({
          id: "label",
          header: "Action",
          cell: ({ row }) => <span className="text-small">{actionLabel(row.original.action)}</span>,
        }),
        helper.accessor("action", {
          header: () => <span className="sr-only">Key</span>,
          cell: (info) => <code className="font-mono text-xs text-gray-10">{info.getValue()}</code>,
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
                className={
                  header.column.id === "label"
                    ? ""
                    : header.column.id === "action"
                      ? "w-px"
                      : "w-16 text-center"
                }
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
              cell.column.id === "label" ? (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ) : cell.column.id === "action" ? (
                // The canonical key names the row for assistive tech; it reads small and muted.
                <th
                  key={cell.id}
                  scope="row"
                  className="p-2 text-left font-normal whitespace-nowrap"
                >
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
