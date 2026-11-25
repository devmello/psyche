export { calendarAdapter } from "./calendar.ts";
export type { FileGrant, FilesDeps } from "./files.ts";
export { filesAdapter, splitFilesCall } from "./files.ts";
export {
  address,
  checkSendRecipe,
  draftContent,
  draftContentHash,
  mailAdapter,
  previewSend,
} from "./mail.ts";
export { remindersAdapter } from "./reminders.ts";
export type * from "./types.ts";

import { calendarAdapter } from "./calendar.ts";
import type { FilesDeps } from "./files.ts";
import { filesAdapter } from "./files.ts";
import { mailAdapter } from "./mail.ts";
import { remindersAdapter } from "./reminders.ts";
import type { Adapter, ReadRegistry } from "./types.ts";

/** Every adapter, keyed by exact tool name. A tool without one is not stageable. */
export function createAdapters(registry: ReadRegistry, files: FilesDeps): Map<string, Adapter> {
  const map = new Map<string, Adapter>();
  for (const a of [
    mailAdapter(registry),
    calendarAdapter(registry),
    remindersAdapter(registry),
    filesAdapter(files),
  ]) {
    for (const t of a.tools) map.set(t, a);
  }
  return map;
}
