import {
  Cable,
  Calendar,
  FileText,
  ListChecks,
  type LucideIcon,
  Mail,
  Plug,
  Workflow,
} from "lucide-react";
import type { ReactElement } from "react";

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
  mcp: Cable,
};

/** The leading tile of a connector row: built-in connectors and MCP servers share it. */
export function ConnectorIcon({ type }: { type: string }): ReactElement {
  const Icon = ICONS[type] ?? Plug;
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-fill-tertiary text-label-secondary"
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  );
}
