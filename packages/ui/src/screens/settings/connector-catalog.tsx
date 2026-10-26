import type { Connector } from "@psyche/protocol";
import type { ReactElement } from "react";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { RadioField } from "./shared.tsx";

/** The connector catalogue: what Add connector offers, and the read / read-and-act choice. */

export type ScopeMode = Connector["scopeMode"];

/** "Read only" / "Read and act", read in the active language on each access. */
export const SCOPE_MODE_LABEL: Readonly<Record<ScopeMode, string>> = {
  get read() {
    return t("settings.connectors.scope.read");
  },
  get read_act() {
    return t("settings.connectors.scope.read_act");
  },
};

/** Read-only vs read-and-act, asked on every connect (Muse asks whether to read mail or also send). */
export function ConnectAccessChoice({
  label,
  value,
  onChange,
  persona,
}: {
  label: string;
  value: ScopeMode;
  onChange: (mode: ScopeMode) => void;
  persona: string;
}): ReactElement {
  return (
    <RadioField
      label={label}
      value={value}
      onChange={onChange}
      options={[
        {
          value: "read",
          label: SCOPE_MODE_LABEL.read,
          hint: t("settings.connectors.scope.readHint", { persona }),
        },
        {
          value: "read_act",
          label: SCOPE_MODE_LABEL.read_act,
          hint: t("settings.connectors.scope.readActHint", { persona }),
        },
      ]}
    />
  );
}

/** Connector types offered in the connect flow (and onboarding). */
type CatalogType =
  | "google"
  | "microsoft"
  | "imap"
  | "apple:notes"
  | "apple:reminders"
  | "apple:calendar"
  | "apple:mail"
  | "apple:shortcuts"
  | "obsidian"
  | "mcp"
  | "slack";

/** Message ids for connector types (ids can't hold the type's colon). */
const CATALOG_ID = {
  google: "google",
  microsoft: "microsoft",
  imap: "imap",
  "apple:notes": "appleNotes",
  "apple:reminders": "appleReminders",
  "apple:calendar": "appleCalendar",
  "apple:mail": "appleMail",
  "apple:shortcuts": "appleShortcuts",
  obsidian: "obsidian",
  mcp: "mcp",
  slack: "slack",
} as const satisfies Record<CatalogType, string>;

/** Slack is a channel, not an account to connect: its row opens Settings → Channels (#529). */
const OPENS: Partial<Record<CatalogType, "channels">> = { slack: "channels" };

const catalogEntry = <T extends CatalogType>(type: T) => ({
  type,
  /** Set for rows that open another Settings section instead of connecting. */
  opens: OPENS[type],
  /** The connector's name, in the active language. */
  get label(): string {
    return t(`settings.connectors.catalog.${CATALOG_ID[type as CatalogType]}`);
  },
});

export const CONNECTOR_CATALOG = [
  catalogEntry("google"),
  catalogEntry("microsoft"),
  catalogEntry("imap"),
  catalogEntry("apple:notes"),
  catalogEntry("apple:reminders"),
  catalogEntry("apple:calendar"),
  catalogEntry("apple:mail"),
  catalogEntry("apple:shortcuts"),
  catalogEntry("obsidian"),
  catalogEntry("mcp"),
  catalogEntry("slack"),
] as const;

/**
 * The catalog rows to offer: the Settings-only rows (Custom MCP server, Slack) always, connectors
 * only when the Gateway's catalogue has an available entry for the type (#529: nothing offered can
 * fail with "no connector implementation"). `implemented` undefined (not loaded yet) offers the
 * connectors too. `navigation: false` (onboarding) leaves out the Settings-only rows.
 */
export function offeredCatalog(
  implemented: ReadonlySet<string> | undefined,
  options: { navigation?: boolean } = {},
) {
  return CONNECTOR_CATALOG.filter((c) =>
    c.opens !== undefined || c.type === "mcp"
      ? options.navigation !== false
      : implemented === undefined || implemented.has(c.type),
  );
}

/**
 * Types that need a setting chosen before they can connect (Obsidian: its vault folder), so they
 * are set up in Settings → Connectors rather than from onboarding's lists (#640).
 */
export function needsSetup(type: string): boolean {
  return type === "obsidian";
}

/** One per machine (the Gateway's `singleInstance`, #549): offered once, then shown Connected. */
export function isSingleInstance(type: string): boolean {
  return type.startsWith("apple:");
}

/** Connector types the Gateway can connect: its catalogue's available entries. */
export function useImplementedTypes(): ReadonlySet<string> | undefined {
  const q = useGatewayQuery("connectors.catalogue", {});
  const entries = q.data?.entries;
  return entries === undefined
    ? undefined
    : new Set(entries.filter((e) => e.available).map((e) => e.type));
}
