/**
 * The one narrow standing grant on a batch approval: the meeting-prep note
 * (`meetings.prep.saveToNotes`, security §3.4–§3.5). It covers `notes_create` calls whose title
 * starts with `Prep:` and nothing else. The Notes connector puts the class in the call's
 * `grantKey`, computed from the real arguments, so a note with any other title can never match.
 */

/** Every prep note's title starts with this. */
export const PREP_NOTE_TITLE_PREFIX = "Prep:";

/** Suffix of the `grantKey` of a Prep-titled `notes_create` call (security §3.5). */
export const PREP_NOTE_GRANT_CLASS = "title-prefix:Prep:";

/** `notes_create`, bare or as a connector tool name (`mcp__<connector>__notes_create`). */
export function isNotesCreateTool(tool: string): boolean {
  return tool === "notes_create" || /^mcp__.+__notes_create$/.test(tool);
}

/** True for a string title that starts with `Prep:` (NFC, case-sensitive, no leading space). */
export function isPrepNoteTitle(title: unknown): title is string {
  return typeof title === "string" && title.normalize("NFC").startsWith(PREP_NOTE_TITLE_PREFIX);
}

/** True when `grantKey` is the Prep-titled `notes_create` class a connector computed. */
export function isPrepNoteGrantKey(grantKey: string): boolean {
  return grantKey.endsWith(`:${PREP_NOTE_GRANT_CLASS}`);
}

/**
 * Whether a call is a Prep-titled `notes_create` whose `grantKey` carries the class. All three
 * must hold: the tool, the title in the real params, and the connector's own key.
 */
export function isPrepNoteCall(call: {
  tool: string;
  params?: unknown;
  grantKey?: string;
}): boolean {
  if (!isNotesCreateTool(call.tool)) return false;
  const p = call.params;
  const title = typeof p === "object" && p !== null ? (p as { title?: unknown }).title : undefined;
  return isPrepNoteTitle(title) && call.grantKey !== undefined && isPrepNoteGrantKey(call.grantKey);
}
