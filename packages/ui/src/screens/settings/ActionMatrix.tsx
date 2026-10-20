import type { Connector } from "@psyche/protocol";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { type ReactElement, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { t } from "../../i18n/core.ts";
import { RadioTableRow } from "./RadioTableRow.tsx";

/**
 * Per-connector action matrix, Allow / Ask / Deny per action (UI design §3.18, as on Muse's
 * Notion connector screen), built on TanStack Table v9 (`useTable` + `table.FlexRender`). Rows say
 * the action in plain words first and show the raw key (`gmail.send`, `mcp__notion__search`)
 * small and muted beside it. Each row is a native radio group, so arrow keys move between rules.
 */

export type ActionRule = Connector["actionMatrix"][string];

const rule = (value: ActionRule) => ({
  value,
  get label(): string {
    return t(`settings.actions.rule.${value}`);
  },
});

export const RULES: readonly { value: ActionRule; readonly label: string }[] = [
  rule("allow"),
  rule("ask"),
  rule("deny"),
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

/** Built-in connector actions with plain-language names (§3.18: "read threads", "send"). */
const KNOWN_ACTIONS = [
  "gmail.read",
  "gmail.send",
  "gmail.draft",
  "gmail.delete",
  "gmail.label",
  "calendar.read",
  "calendar.write",
  "calendar.delete",
  "contacts.read",
  "drive.read",
  "drive.write",
] as const;

const isKnownAction = (a: string): a is (typeof KNOWN_ACTIONS)[number] =>
  (KNOWN_ACTIONS as readonly string[]).includes(a);

/**
 * What a row says first: "read threads" for `gmail.read`, "create page" for
 * `mcp__notion__create_page`. The raw key stays beside it at disclosure level 2 (§4.12).
 */
export function actionLabel(action: string): string {
  if (isKnownAction(action)) return t(`settings.actions.known.${action}`);
  if (isMcpKey(action)) return (action.split("__").pop() ?? action).replaceAll("_", " ");
  const [family = action, verb] = action.split(".");
  if (verb === undefined) return action.replaceAll("_", " ");
  return t("settings.actions.generic", {
    verb,
    raw: verb.replaceAll("_", " "),
    family: family.replaceAll("_", " "),
  });
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
  const data = useMemo<MatrixRow[]>(
    () => Object.entries(matrix).map(([action, rule]) => ({ action, rule })),
    [matrix],
  );
  const columns = useMemo(
    () =>
      helper.columns([
        helper.display({
          id: "label",
          header: t("settings.actions.action"),
          cell: ({ row }) => <span className="text-small">{actionLabel(row.original.action)}</span>,
        }),
        helper.accessor("action", {
          header: () => <span className="sr-only">{t("settings.actions.key")}</span>,
          cell: (info) => <code className="font-mono text-xs text-gray-11">{info.getValue()}</code>,
        }),
        ...RULES.map((r) =>
          helper.display({
            id: r.value,
            header: r.label,
            cell: () => null,
          }),
        ),
      ]),
    [],
  );
  const table = useTable({ features, columns, data });

  return (
    <Table aria-label={t("settings.actions.table", { connector: connectorLabel })}>
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
          <RadioTableRow
            key={row.id}
            label={actionLabel(row.original.action)}
            rowProps={{ "data-rule": row.original.rule }}
            header={row
              .getAllCells()
              .filter((cell) => cell.column.id === "label" || cell.column.id === "action")
              .map((cell) =>
                cell.column.id === "label" ? (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ) : (
                  // The canonical key names the row for assistive tech; it reads small and muted.
                  <th
                    key={cell.id}
                    scope="row"
                    className="p-2 text-start font-normal whitespace-nowrap"
                  >
                    <table.FlexRender cell={cell} />
                  </th>
                ),
              )}
            options={RULES}
            value={row.original.rule}
            disabled={disabled}
            onChange={(rule) => onChange(row.original.action, rule)}
          />
        ))}
      </TableBody>
    </Table>
  );
}
