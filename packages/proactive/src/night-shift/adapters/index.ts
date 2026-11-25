export { type CalendarDeps, type CalendarFlavor, calendarAdapter, splitTool } from "./calendar.ts";
export type { FileGrant, FilesDeps } from "./files.ts";
export { filesAdapter, splitFilesCall } from "./files.ts";
export {
  checkSendRecipe,
  draftContent,
  draftContentHash,
  hasHiddenContent,
  mailAdapter,
  previewSend,
  strictAddress,
} from "./mail.ts";
export { remindersAdapter } from "./reminders.ts";
export type * from "./types.ts";

import { type CalendarDeps, calendarAdapter, splitTool } from "./calendar.ts";
import type { FilesDeps } from "./files.ts";
import { filesAdapter } from "./files.ts";
import { mailAdapter } from "./mail.ts";
import { remindersAdapter } from "./reminders.ts";
import type { Adapter, ReadRegistry } from "./types.ts";

/** Every adapter, keyed by exact tool name. A tool without one is not stageable. */
export function createAdapters(
  registry: ReadRegistry,
  files: FilesDeps,
  calendar: CalendarDeps = {},
): Map<string, Adapter> {
  const map = new Map<string, Adapter>();
  for (const a of [
    mailAdapter(registry),
    calendarAdapter(registry, calendar),
    remindersAdapter(registry),
    filesAdapter(files),
  ]) {
    for (const t of a.tools) map.set(t, a);
  }
  return map;
}

/** The adapter for a tool, including a connector-prefixed name (`mcp__google__calendar_...`). */
export function adapterFor(adapters: Map<string, Adapter>, tool: string): Adapter | undefined {
  return adapters.get(tool) ?? adapters.get(splitTool(tool).bare);
}
