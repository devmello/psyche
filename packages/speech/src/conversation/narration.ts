/**
 * Tool-step narration (docs/voice/voice-mode-2026.md §4.5): what Psyche says while a step runs.
 * The words come from these fixed templates, chosen by the tool's name, never from the model or
 * the tool's arguments. So injected content (a subject line, a page title) can't choose what is
 * said aloud.
 */

/** A step running longer than this gets one spoken phrase in `brief` narration. */
export const NARRATE_SLOW_MS = 1_500;

const FAMILIES: readonly [RegExp, string][] = [
  [/^(calendar|events?)[._]/, "Checking your calendar"],
  [/^(reminders?|tasks?)[._]/, "Checking your reminders"],
  [/^(mail|email|gmail)[._]|_mail$|^send_email$/, "Working on your mail"],
  [/^(notes?)[._]/, "Looking in your notes"],
  [/^(contacts?|people)[._]/, "Looking up a contact"],
  [/^(messages?|imessage)[._]/, "Checking your messages"],
  [/^(files?|finder|fs)[._]|^(read|write|edit)_file$/, "Working with your files"],
  [/^(web_search|search_web|browse|browser|fetch|web)[._]?/, "Looking that up"],
  [/^(memory|remember|recall)[._]?/, "Checking what I remember"],
  [/^(music|spotify)[._]/, "Getting the music ready"],
  [/^(shortcuts?)[._]/, "Running a shortcut"],
  [/^(sandbox|exec|code|shell|terminal)[._]?/, "Running that"],
  [/^(sheet|spreadsheet|doc|document|pdf)[._]?/, "Working on the document"],
];

/** The phrase for a tool, from its name (`calendar_list_events` → "Checking your calendar"). */
export function narrationLabel(tool: string): string {
  const name = tool.toLowerCase().replace(/^mcp__[^_]+__/, "");
  for (const [re, label] of FAMILIES) if (re.test(name)) return label;
  return "Working on it";
}
