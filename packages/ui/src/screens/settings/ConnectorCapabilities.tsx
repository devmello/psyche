import type { Connector, ConnectorCatalogueEntry } from "@psyche/protocol";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { floorClassOf, unliftable, useLiftFloorConfirm } from "../../blocks/LiftFloorDialog.tsx";
import { activeI18n, isMessageId, t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { type ActionRule, RULES } from "./ActionMatrix.tsx";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
import { GROUP_ROWS } from "./shared.tsx";

/**
 * Settings → Connectors, an Apple app's card (docs/connectors/apple-apps-2026.md §7.1, #640):
 * what the persona can do in plain words, one Allow / Ask / Deny control per action group (the
 * action matrix, grouped as the Gateway's catalogue lists it), the macOS grant the app uses, and
 * "Try it" requests that fill the chat composer.
 */

export type CatalogueAction = ConnectorCatalogueEntry["actions"][number];

/** `apple:mail` → `mail`; null for anything that is not an app on this Mac. */
export function appleApp(type: string): string | null {
  return type.startsWith("apple:") ? type.slice("apple:".length) : null;
}

/** The System Settings grant an app needs: Automation of the app, or a framework's data class. */
const GRANT: Readonly<Record<string, { kind: "automation" | MessageGrant; app?: string }>> = {
  mail: { kind: "automation", app: "mail" },
  notes: { kind: "automation", app: "notes" },
  music: { kind: "automation", app: "music" },
  safari: { kind: "automation", app: "safari" },
  chrome: { kind: "automation", app: "chrome" },
  things: { kind: "automation", app: "things" },
  shortcuts: { kind: "automation", app: "shortcuts" },
  calendar: { kind: "calendars" },
  reminders: { kind: "reminders" },
  contacts: { kind: "contacts" },
  photos: { kind: "photos" },
};
type MessageGrant = "calendars" | "reminders" | "contacts" | "photos";

/** "Automation → Mail", "Calendars": the grant's name as System Settings shows it. */
export function grantName(app: string): string | null {
  const g = GRANT[app];
  if (g === undefined) return null;
  if (g.kind !== "automation") return t(`settings.connectors.grant.${g.kind}`);
  const id = `settings.connectors.app.${g.app ?? app}`;
  return t("settings.connectors.grant.automation", { app: isMessageId(id) ? t(id) : app });
}

/** Example requests per app ("Try it"), in the catalogue under `settings.connectors.try.<app>.*`. */
const TRY: Readonly<Record<string, readonly string[]>> = {
  mail: ["unread", "reminder", "reply"],
  notes: ["find", "append"],
  reminders: ["due", "add"],
  calendar: ["today", "focus"],
};

export function tryRequests(app: string): string[] {
  return (TRY[app] ?? [])
    .map((key) => `settings.connectors.try.${app}.${key}`)
    .filter(isMessageId)
    .map((id) => t(id));
}

/** An action group's name and capability line: the catalogue's words when the kit has none. */
function groupText(action: CatalogueAction): { title: string; lines: string | null } {
  const title = `settings.connectors.can.${action.id}.title`;
  const lines = `settings.connectors.can.${action.id}.lines`;
  return {
    title: isMessageId(title) ? t(title) : action.title,
    lines: isMessageId(lines) ? t(lines) : null,
  };
}

/**
 * Device-only and authentication actions (credential entry, purchases, scripts, …) always ask:
 * Allow is never offered for them (security §3.7, §3.12).
 */
export function alwaysAsks(action: CatalogueAction): boolean {
  return unliftable(action.approvalKind);
}

/** Sends, deletes and payments ask unless the owner lifted the floor with a confirm (§3.12). */
export function liftableFloor(action: CatalogueAction) {
  return alwaysAsks(action) ? null : floorClassOf(action.approvalKind, action.sideEffect);
}

export interface CapabilityCardProps {
  connector: Connector;
  /** The connector type's action groups from `connectors.catalogue`. */
  actions: readonly CatalogueAction[];
  persona: string;
  /**
   * `liftFloor`: for a send / destructive / financial group, whether the owner confirmed Allow
   * (true) or left it (false); absent for other groups.
   */
  onRuleChange?: (action: string, rule: ActionRule, liftFloor?: boolean) => void;
  /** The groups whose floor the owner lifted (`permissions.liftedFloors.<id>`). */
  lifted?: readonly string[];
  /** Fills the chat composer with an example request; absent hides "Try it". */
  onTry?: (text: string) => void;
  /** Opens with the groups showing (stories). */
  defaultOpen?: boolean;
}

/** The expandable part of an Apple app's row: groups, grant and "Try it". */
export function CapabilityCard({
  connector,
  actions,
  persona,
  onRuleChange,
  lifted = [],
  onTry,
  defaultOpen = false,
}: CapabilityCardProps): ReactElement | null {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const confirm = useLiftFloorConfirm(persona, "matrix");
  const app = appleApp(connector.type);
  if (app === null || actions.length === 0) return null;
  const grant = grantName(app);
  const connected = connector.status === "connected";
  const readOnly = connector.scopeMode === "read";
  const examples = connected && onTry ? tryRequests(app) : [];
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-groups`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-fit cursor-default items-center gap-1 rounded-sm text-callout text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-(--duration-micro) rtl:rotate-180",
            open && "rotate-90 rtl:rotate-90",
          )}
        />
        {t("settings.connectors.can.title", { persona })}
      </button>
      {open ? (
        <div id={`${id}-groups`} className="flex flex-col gap-2">
          <ul
            aria-label={t("settings.connectors.can.label", { persona, name: connector.label })}
            className={cn(GROUP_ROWS, "bg-fill-quaternary shadow-none")}
          >
            {actions.map((action) => {
              const { title, lines } = groupText(action);
              const rule: ActionRule = connector.actionMatrix[action.id] ?? action.defaultRule;
              const asks = alwaysAsks(action);
              const floor = liftableFloor(action);
              const isLifted = floor !== null && lifted.includes(action.id);
              // A plain allow never lifts a floor: it shows as Ask until the owner confirms.
              const shown: ActionRule =
                (asks || (floor !== null && !isLifted)) && rule === "allow" ? "ask" : rule;
              const off = readOnly && action.sideEffect !== "read";
              const choose = (next: ActionRule) => {
                if (floor === null) return onRuleChange?.(action.id, next);
                if (next !== "allow") return onRuleChange?.(action.id, next, false);
                const what = t("settings.connectors.can.liftWhat", {
                  action: title.toLocaleLowerCase(activeI18n().locale),
                  name: connector.label,
                });
                confirm.ask(floor, what, () => onRuleChange?.(action.id, "allow", true));
              };
              return (
                <li key={action.id} data-rule={rule} className="flex items-center gap-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body text-label-primary">{title}</span>
                    {lines ? (
                      <span className="text-callout text-label-secondary">{lines}</span>
                    ) : null}
                    {off ? (
                      <span className="text-callout text-label-tertiary">
                        {t("settings.connectors.can.readOnly", { name: connector.label })}
                      </span>
                    ) : asks ? (
                      <span className="text-callout text-label-tertiary">
                        {t("settings.connectors.can.alwaysAsks")}
                      </span>
                    ) : floor !== null ? (
                      <span className="text-callout text-label-tertiary">
                        {isLifted && shown === "allow"
                          ? t("settings.connectors.can.lifted")
                          : t("settings.connectors.can.asksByDefault")}
                      </span>
                    ) : null}
                  </div>
                  {off ? null : (
                    <SegmentedRadio
                      label={title}
                      options={asks ? RULES.filter((r) => r.value !== "allow") : RULES}
                      value={shown}
                      disabled={onRuleChange === undefined}
                      onChange={choose}
                      segmentLabel={(o) =>
                        t("settings.matrix.cell", { row: title, column: o.label })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {connected && grant ? (
            <p className="flex items-center gap-1.5 text-callout text-label-secondary">
              <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0 text-success-text" />
              {t("settings.connectors.grant.allowed", { grant })}
            </p>
          ) : null}
          {examples.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span id={`${id}-try`} className="text-callout text-label-secondary">
                {t("settings.connectors.try.title")}
              </span>
              <ul aria-labelledby={`${id}-try`} className="flex flex-wrap gap-2">
                {examples.map((text) => (
                  <li key={text}>
                    <button
                      type="button"
                      onClick={() => onTry?.(text)}
                      className="inline-flex h-7 cursor-default items-center rounded-full bg-fill-tertiary px-3 text-callout text-label-primary outline-none transition-colors duration-(--duration-micro) hover:bg-fill-secondary focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {confirm.dialog}
    </div>
  );
}
