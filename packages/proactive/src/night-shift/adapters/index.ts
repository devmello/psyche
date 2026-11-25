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

import { type CalendarFlavor, calendarAdapter, splitTool } from "./calendar.ts";
import type { FilesDeps } from "./files.ts";
import { filesAdapter } from "./files.ts";
import { mailAdapter } from "./mail.ts";
import { remindersAdapter } from "./reminders.ts";
import type { Adapter, ReadRegistry } from "./types.ts";

/**
 * The live connectors, from the connector registry: connector id to connector type (`apple`,
 * `google`, `microsoft`, `mail`, ...). It is injected, never guessed from a name: an MCP server's
 * tool is `mcp__<server>__<tool>` too, and nothing in the name tells the two apart.
 */
export type ConnectorTypes = ReadonlyMap<string, string>;

/** Connector types whose tools may be staged. Everything else (custom, shopping, web, MCP) is not. */
const STAGEABLE_TYPES: ReadonlySet<string> = new Set(["apple", "google", "microsoft", "mail"]);

const CALENDAR_FLAVORS: ReadonlySet<string> = new Set(["apple", "google", "microsoft"]);

/** Every adapter, keyed by bare tool name. Use `adapterFor` to look one up for a real call. */
export function createAdapters(
  registry: ReadRegistry,
  files: FilesDeps,
  connectors: ConnectorTypes,
): Map<string, Adapter> {
  const flavorOf = (id: string): CalendarFlavor | undefined => {
    const t = connectors.get(id);
    return t !== undefined && CALENDAR_FLAVORS.has(t) ? (t as CalendarFlavor) : undefined;
  };
  const map = new Map<string, Adapter>();
  for (const a of [
    mailAdapter(registry),
    calendarAdapter(registry, { flavorOf }),
    remindersAdapter(registry),
    filesAdapter(files),
  ]) {
    for (const t of a.tools) map.set(t, a);
  }
  return map;
}

/**
 * The adapter for a call's tool. A connector-prefixed name is stageable only when that connector is
 * live and of a stageable type; any other prefix (`mcp__evil__mail_create_draft`,
 * `mcp__some-mcp-server__files_move`) has no adapter. A bare name is looked up as it is.
 */
export function adapterFor(
  adapters: Map<string, Adapter>,
  tool: string,
  connectors: ConnectorTypes,
): Adapter | undefined {
  const { connector, bare } = splitTool(tool);
  if (connector !== undefined) {
    const type = connectors.get(connector);
    if (type === undefined || !STAGEABLE_TYPES.has(type)) return undefined;
  }
  return adapters.get(bare);
}
