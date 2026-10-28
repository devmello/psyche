import type { Connector } from "@psyche/protocol";
import { Ellipsis } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { t } from "../../i18n/core.ts";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
import { GROUP_ROWS } from "./shared.tsx";

/**
 * Per-connector action matrix, Allow / Ask / Deny per action (UI design §3.18, as on Muse's
 * Notion connector screen).
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

function isRule(v: unknown): v is ActionRule {
  return v === "allow" || v === "ask" || v === "deny";
}

/** Applies `permissions.connectors.<id>` overrides from settings to each connector's matrix. */
export function withMatrixOverrides(
  connectors: readonly Connector[],
  values: Readonly<Record<string, unknown>>,
): Connector[] {
  return connectors.map((c) => {
    const o = values[`permissions.connectors.${c.id}`];
    if (typeof o !== "object" || o === null) return c;
    const matrix = { ...c.actionMatrix };
    for (const [k, v] of Object.entries(o)) if (isRule(v)) matrix[k] = v;
    return { ...c, actionMatrix: matrix };
  });
}

/**
 * `permissions.liftedFloors.<id>` from settings: the actions whose send / destructive / financial
 * floor the owner lifted with a confirm (security §3.12), by connector id.
 */
export function liftedFloorsOf(
  values: Readonly<Record<string, unknown>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const prefix = "permissions.liftedFloors.";
  for (const [k, v] of Object.entries(values)) {
    if (!k.startsWith(prefix) || !Array.isArray(v)) continue;
    out[k.slice(prefix.length)] = v.filter((a): a is string => typeof a === "string");
  }
  return out;
}

export interface ActionMatrixProps {
  connectorLabel: string;
  matrix: Readonly<Record<string, ActionRule>>;
  onChange: (action: string, rule: ActionRule) => void;
  disabled?: boolean;
}

/**
 * A connector's actions as a grouped inset list (redesign §5.8): each row says the action in
 * plain words with one Allow / Ask / Deny segmented control trailing. The raw key
 * (`gmail.send`, `mcp__notion__search`) appears only from the row's ⋯ → "Show technical name".
 */
export function ActionMatrix({
  connectorLabel,
  matrix,
  onChange,
  disabled = false,
}: ActionMatrixProps): ReactElement {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const toggle = (action: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (next.has(action)) next.delete(action);
      else next.add(action);
      return next;
    });
  return (
    <ul
      aria-label={t("settings.actions.table", { connector: connectorLabel })}
      className={GROUP_ROWS}
    >
      {Object.entries(matrix).map(([action, value]) => {
        const label = actionLabel(action);
        return (
          <li key={action} data-rule={value} className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body text-label-primary">{label}</span>
              {shown.has(action) ? (
                <code className="truncate font-mono text-mono text-label-secondary">{action}</code>
              ) : null}
            </div>
            <SegmentedRadio
              label={label}
              options={RULES}
              value={value}
              disabled={disabled}
              onChange={(rule) => onChange(action, rule)}
              segmentLabel={(o) => t("settings.matrix.cell", { row: label, column: o.label })}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("settings.actions.more", { action: label })}
                  />
                }
              >
                <Ellipsis aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => toggle(action)}>
                  {shown.has(action)
                    ? t("settings.actions.hideKey")
                    : t("settings.actions.showKey")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );
}
