import type { ConnectorsView } from "./ConnectorsSection.tsx";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-pages.ts";

/** Where a `/settings/...` route lands: a page or a pane, and for Connectors the view it opens on. */
export interface SettingsTarget {
  section: SettingsSectionId;
  view?: ConnectorsView;
}

/**
 * `/settings/:section[/:view]`. Every id from before the 2026 regrouping still opens: a page id
 * opens the page, an old section id opens its page scrolled to that pane (docs/design/
 * settings-2026.md). Unknown ids fall back to General. MCP servers used to be a section of their
 * own: `/settings/mcp` lands on Connectors listing the MCP servers, and
 * `/settings/connectors/add-mcp` (⌘K "Add MCP server") opens the Custom MCP server form.
 */
export function parseSettingsRoute(route: string): SettingsTarget | null {
  const m = /^\/settings(?:\/([^/?#]+)(?:\/([^/?#]+))?)?/.exec(route);
  if (m === null) return null;
  if (m[1] === "mcp") return { section: "connectors", view: "mcp" };
  const section = SETTINGS_SECTIONS.find((s) => s.id === m[1])?.id ?? "general";
  if (section === "connectors" && (m[2] === "mcp" || m[2] === "add-mcp")) {
    return { section, view: m[2] };
  }
  return { section };
}
