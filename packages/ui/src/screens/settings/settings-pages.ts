import {
  Activity,
  Bell,
  Bot,
  Brain,
  BrainCircuit,
  Briefcase,
  CalendarClock,
  Cpu,
  Database,
  Eye,
  FolderLock,
  Globe,
  GraduationCap,
  Info,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Mail,
  MessagesSquare,
  Mic,
  MonitorCog,
  MonitorSmartphone,
  MousePointerClick,
  Palette,
  Plug,
  Puzzle,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";
import { t } from "../../i18n/core.ts";

/**
 * The Settings window's structure (docs/design/settings-2026.md): nine pages in the sidebar, each
 * a column of panes. A pane is one of the old sections, kept whole so its settings, stories and
 * tests stay put; its id is still a route (`/settings/files` opens Permissions at File access), so
 * every deep link from before keeps working. A page's id is its first pane's id where it has one,
 * so `/settings/model` lands at the top of Models either way.
 */

export type SettingsPageId =
  | "essentials"
  | "general"
  | "model"
  | "connectors"
  | "memory"
  | "daily"
  | "permissions"
  | "data"
  | "devices"
  | "about";

export type SettingsPaneId =
  | "essentials"
  | "appearance"
  | "persona"
  | "notifications"
  | "voice"
  | "model"
  | "usage"
  | "connectors"
  | "search"
  | "mail"
  | "channels"
  | "memory"
  | "learning"
  | "everything"
  | "work"
  | "surfaces"
  | "people"
  | "daily"
  | "skills"
  | "specialists"
  | "permissions"
  | "computer-use"
  | "browser"
  | "files"
  | "credentials"
  | "vm"
  | "data"
  | "devices"
  | "server"
  | "about";

/** Every `/settings/<id>`: a page, or a pane inside one. */
export type SettingsSectionId = SettingsPageId | SettingsPaneId;

interface SettingsEntry<Id extends string> {
  id: Id;
  /** The sidebar label, in the active language. */
  readonly label: string;
  icon: LucideIcon;
}

/** A pane (an old section): its label is `settings.nav.<id>`. */
const entry = (id: SettingsPaneId, icon: LucideIcon): SettingsEntry<SettingsPaneId> => ({
  id,
  icon,
  get label() {
    // Message ids are camelCase; the route id keeps its hyphen.
    return t(`settings.nav.${id === "computer-use" ? "computerUse" : id}`);
  },
});

export interface SettingsPage extends SettingsEntry<SettingsPageId> {
  /** One line under the page title, with the persona's name. */
  description: (persona: string) => string;
  panes: readonly SettingsPaneId[];
}

const page = (
  id: SettingsPageId,
  icon: LucideIcon,
  panes: readonly SettingsPaneId[],
): SettingsPage => ({
  id,
  icon,
  panes,
  get label() {
    return t(`settings.page.${id}`);
  },
  description: (persona) => t(`settings.page.${id}.description`, { persona }),
});

export const SETTINGS_PANES: readonly SettingsEntry<SettingsPaneId>[] = [
  entry("essentials", ListChecks),
  entry("appearance", Palette),
  entry("persona", UserRound),
  entry("notifications", Bell),
  entry("voice", Mic),
  entry("model", Bot),
  entry("usage", Activity),
  entry("connectors", Plug),
  entry("search", Search),
  entry("mail", Mail),
  entry("channels", MessagesSquare),
  entry("memory", BrainCircuit),
  entry("learning", GraduationCap),
  entry("everything", Brain),
  entry("work", Briefcase),
  entry("surfaces", Eye),
  entry("people", Users),
  entry("daily", CalendarClock),
  entry("skills", Puzzle),
  entry("specialists", Workflow),
  entry("permissions", ShieldCheck),
  entry("computer-use", MousePointerClick),
  entry("browser", Globe),
  entry("files", FolderLock),
  entry("credentials", KeyRound),
  entry("vm", MonitorCog),
  entry("data", Database),
  entry("devices", MonitorSmartphone),
  entry("server", Server),
  entry("about", Info),
];

/**
 * The sidebar, in the order people need it: Essentials (the few choices a newcomer makes) first,
 * everyday choices next, plumbing last.
 */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  page("essentials", ListChecks, ["essentials"]),
  page("general", SlidersHorizontal, ["appearance", "persona", "notifications", "voice"]),
  page("model", Cpu, ["model", "usage"]),
  page("connectors", Plug, ["connectors", "search", "mail", "channels"]),
  page("memory", Brain, ["learning", "memory", "everything", "work", "surfaces", "people"]),
  page("daily", CalendarClock, ["daily", "skills", "specialists"]),
  page("permissions", ShieldCheck, [
    "permissions",
    "computer-use",
    "browser",
    "files",
    "credentials",
    "vm",
  ]),
  page("data", Database, ["data"]),
  page("devices", MonitorSmartphone, ["devices", "server"]),
  page("about", Info, ["about"]),
];

/**
 * Every route id in window order: each page, then its other panes (the protocol's
 * `APP_SETTINGS_SECTIONS`). A page's own id carries the page's label.
 */
export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; readonly label: string }[] =
  SETTINGS_PAGES.flatMap((p) => [
    p,
    ...SETTINGS_PANES.filter((pane) => pane.id !== p.id && p.panes.includes(pane.id)),
  ]);

const PAGE_OF_PANE = new Map<SettingsPaneId, SettingsPage>(
  SETTINGS_PAGES.flatMap((p) => p.panes.map((id) => [id, p] as const)),
);

export function pageById(id: SettingsPageId): SettingsPage {
  return SETTINGS_PAGES.find((p) => p.id === id) ?? (SETTINGS_PAGES[0] as SettingsPage);
}

export function paneById(id: SettingsPaneId): SettingsEntry<SettingsPaneId> | undefined {
  return SETTINGS_PANES.find((p) => p.id === id);
}

/** The page holding a pane. */
export function pageOfPane(id: SettingsPaneId): SettingsPage {
  return PAGE_OF_PANE.get(id) ?? (SETTINGS_PAGES[0] as SettingsPage);
}

/**
 * Where a route id lands: its page, and the pane to scroll to (none for a page's own id, which
 * opens at the top). Unknown ids open Essentials.
 */
export function resolveSection(id: string | undefined): {
  page: SettingsPageId;
  pane?: SettingsPaneId;
} {
  const asPage = SETTINGS_PAGES.find((p) => p.id === id);
  if (asPage !== undefined) return { page: asPage.id };
  const asPane = SETTINGS_PANES.find((p) => p.id === id);
  if (asPane !== undefined) return { page: pageOfPane(asPane.id).id, pane: asPane.id };
  return { page: "essentials" };
}

/** The pane a setting key lives in, so Search can jump straight to it. */
export function paneForKey(key: string): SettingsPaneId | null {
  const root = key.split(".", 1)[0] ?? "";
  if (key.startsWith("permissions.folders")) return "files";
  if (key.startsWith("memory.work")) return "work";
  if (key.startsWith("memory.surfaces")) return "surfaces";
  if (key.startsWith("memory.everything.review")) return "memory";
  if (key.startsWith("memory.everything")) return "everything";
  if (key.startsWith("search.")) return "search";
  if (key === "data.transcriptRecall") return "learning";
  if (key === "agent.showReasoning") return "persona";
  if (key.startsWith("memory.graph")) return "people";
  if (key === "ui.links.openIn") return "browser";
  if (key === "capabilities.onlineSearch" || key === "tools.loading") return "connectors";
  const byRoot: Record<string, SettingsPaneId> = {
    appearance: "appearance",
    ui: "appearance",
    backup: "data",
    browser: "browser",
    computerUse: "computer-use",
    data: "data",
    devices: "devices",
    gateway: "server",
    memory: "learning",
    map: "data",
    widgets: "data",
    models: "model",
    context: "model",
    exec: "connectors",
    teaching: "learning",
    tools: "model",
    notifications: "notifications",
    nudges: "people",
    people: "people",
    permissions: "permissions",
    persona: "persona",
    vm: "vm",
    voice: "voice",
    screenAsk: "voice",
    quickEntry: "voice",
    mail: "mail",
    meetings: "mail",
    workflows: "mail",
    daily: "daily",
    vault: "credentials",
    channels: "channels",
    mcp: "connectors",
    connectors: "connectors",
    skills: "skills",
    specialists: "specialists",
  };
  return byRoot[root] ?? null;
}
