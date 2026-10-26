import type { ConnectorsView } from "./ConnectorsSection.tsx";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./SettingsScreen.tsx";

/** Where a `/settings/...` route lands: a section, and for Connectors the view it opens on. */
export interface SettingsTarget {
  section: SettingsSectionId;
  view?: ConnectorsView;
}

/**
 * `/settings/:section[/:view]`. Unknown sections fall back to the first one. MCP servers used to
 * be a section of their own: `/settings/mcp` lands on Connectors listing the MCP servers, and
 * `/settings/connectors/add-mcp` (⌘K "Add MCP server") opens the Custom MCP server form.
 */
export function parseSettingsRoute(route: string): SettingsTarget | null {
  const m = /^\/settings(?:\/([^/?#]+)(?:\/([^/?#]+))?)?/.exec(route);
  if (m === null) return null;
  if (m[1] === "mcp") return { section: "connectors", view: "mcp" };
  const section = SETTINGS_SECTIONS.find((s) => s.id === m[1])?.id ?? "model";
  if (section === "connectors" && (m[2] === "mcp" || m[2] === "add-mcp")) {
    return { section, view: m[2] };
  }
  return { section };
}
