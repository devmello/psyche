import {
  AppWindow,
  Brain,
  Bug,
  Cable,
  Calendar,
  Clock,
  Cloud,
  CloudSun,
  CreditCard,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Home,
  ListChecks,
  type LucideIcon,
  Mail,
  MapPin,
  MessagesSquare,
  Music,
  Plug,
  Search,
  Table2,
  Workflow,
} from "lucide-react";
import type { ReactElement } from "react";
import type { PresetIcon } from "./mcp-preset-build.ts";

const ICONS: Readonly<Record<string, LucideIcon>> = {
  google: Mail,
  microsoft: Mail,
  imap: Mail,
  "apple:mail": Mail,
  "apple:calendar": Calendar,
  "apple:notes": FileText,
  obsidian: FileText,
  "apple:reminders": ListChecks,
  "apple:shortcuts": Workflow,
  slack: MessagesSquare,
  mcp: Cable,
};

const PRESET_ICONS: Readonly<Record<PresetIcon, LucideIcon>> = {
  folder: FolderOpen,
  database: Database,
  brain: Brain,
  git: GitBranch,
  bug: Bug,
  tasks: ListChecks,
  doc: FileText,
  cloud: Cloud,
  globe: Globe,
  search: Search,
  browser: AppWindow,
  weather: CloudSun,
  clock: Clock,
  map: MapPin,
  music: Music,
  home: Home,
  card: CreditCard,
  chat: MessagesSquare,
  table: Table2,
};

/** The leading tile of a connector row or gallery tile: connectors, MCP servers and presets share it. */
export function ConnectorIcon({ type, icon }: { type?: string; icon?: PresetIcon }): ReactElement {
  const Icon = (icon ? PRESET_ICONS[icon] : type ? ICONS[type] : undefined) ?? Plug;
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-fill-tertiary text-label-secondary"
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  );
}
