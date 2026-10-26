import type { ApprovalKind, SideEffect } from "@psyche/protocol";

/**
 * Action matrix for the mac helper's Apple app adapters (feature J6: "each adapter has an action
 * matrix in Permissions"; architecture §4.9 "Allow / Ask / Deny per action"). Node calls reach the
 * broker as `node.<capability>`; each maps to a connector key `apple.<app>` / `<action>` that the
 * owner can set in `policy.connectors`. Without an owner entry the default below applies.
 * `alwaysAsk` actions (sending mail) never become silent: an owner `allow` still asks. None of
 * these kinds is device-only (security §3.7, §9: device-only covers financial, credential fills,
 * exec_host, policy and pairing).
 */
export interface AppleAppAction {
  connector: `apple.${string}`;
  action: string;
  sideEffect: SideEffect;
  kind: ApprovalKind;
  default: "allow" | "ask" | "deny";
  alwaysAsk?: true;
}

const read = (connector: AppleAppAction["connector"], action: string): AppleAppAction => ({
  connector,
  action,
  sideEffect: "read",
  kind: "connector_action",
  default: "allow",
});

const write = (
  connector: AppleAppAction["connector"],
  action: string,
  kind: ApprovalKind = "connector_action",
  extra: Partial<AppleAppAction> = {},
): AppleAppAction => ({ connector, action, sideEffect: "write", kind, default: "ask", ...extra });

/** Keyed by helper capability name (without the `node.` prefix). */
export const APPLE_APP_ACTIONS: Readonly<Record<string, AppleAppAction>> = {
  "calendar.list_calendars": read("apple.calendar", "list_calendars"),
  "calendar.list_events": read("apple.calendar", "list_events"),
  "calendar.create_event": write("apple.calendar", "create_event", "calendar_write"),
  "calendar.update_event": write("apple.calendar", "update_event", "calendar_write"),
  "reminders.list_lists": read("apple.reminders", "list_lists"),
  "reminders.list": read("apple.reminders", "list"),
  "reminders.create": write("apple.reminders", "create"),
  "reminders.update": write("apple.reminders", "update"),
  // Wave 1 (docs/connectors/apple-apps-2026.md §4.2, §4.3; #639).
  "reminders.complete": write("apple.reminders", "complete"),
  "reminders.set_flagged": write("apple.reminders", "set_flagged"),
  "reminders.delete": write("apple.reminders", "delete", "connector_action", {
    sideEffect: "destructive",
  }),
  "calendar.free_busy": read("apple.calendar", "free_busy"),
  "calendar.delete_event": write("apple.calendar", "delete_event", "calendar_write", {
    sideEffect: "destructive",
  }),
  "mail.search": read("apple.mail", "search"),
  "mail.read": read("apple.mail", "read"),
  "mail.draft": write("apple.mail", "draft"),
  // Never send without an approval card (J6).
  "mail.send": write("apple.mail", "send", "send_email", { alwaysAsk: true }),
  // Wave 1 (docs/connectors/apple-apps-2026.md §4.1, #639).
  "mail.mailboxes": read("apple.mail", "mailboxes"),
  "mail.selected": read("apple.mail", "selected"),
  "mail.reply_draft": write("apple.mail", "reply_draft"),
  "mail.forward_draft": write("apple.mail", "forward_draft"),
  // Sending a saved draft is a send: always a card bound to its recipients and body.
  "mail.send_draft": write("apple.mail", "send_draft", "send_email", { alwaysAsk: true }),
  "mail.set_flags": write("apple.mail", "set_flags"),
  "mail.move": write("apple.mail", "move"),
  "mail.save_attachments": write("apple.mail", "save_attachments"),
  "notes.list": read("apple.notes", "list"),
  "notes.read": read("apple.notes", "read"),
  "notes.create": write("apple.notes", "create"),
  // Wave 1 (docs/connectors/apple-apps-2026.md §4.4; #639).
  "notes.search": read("apple.notes", "search"),
  "notes.folders": read("apple.notes", "folders"),
  "notes.append": write("apple.notes", "append"),
  "notes.update": write("apple.notes", "update"),
  // Music and Spotify (wave 1, §4.6; #639). Direct node calls ask for writes like every other
  // app; the connector's own matrix allows the agent's playback tools by default.
  "music.now_playing": read("apple.music", "now_playing"),
  "music.search_library": read("apple.music", "search_library"),
  "music.control": write("apple.music", "control"),
  "music.play": write("apple.music", "play"),
  // Contacts (wave 1, docs/connectors/apple-apps-2026.md §4.5; #639).
  "contacts.search": read("apple.contacts", "search"),
  "contacts.read": read("apple.contacts", "read"),
  "contacts.create": write("apple.contacts", "create"),
  "contacts.update": write("apple.contacts", "update"),
  "finder.list": read("apple.finder", "list"),
  "finder.reveal": read("apple.finder", "reveal"),
  "safari.tabs": read("apple.safari", "tabs"),
  "safari.current_tab": read("apple.safari", "current_tab"),
  // Wave 1 (§4.7; #639).
  "safari.tab_text": read("apple.safari", "tab_text"),
  // Google Chrome tabs through the same helper route (the key keeps the apple.* namespace).
  "chrome.tabs": read("apple.chrome", "tabs"),
  "chrome.current_tab": read("apple.chrome", "current_tab"),
  "safari.add_reading_list": write("apple.safari", "add_reading_list"),
  // Opens a page in the user's own Safari (their cookies): asks like a new origin.
  "safari.open_url": write("apple.safari", "open_url", "new_origin"),
};

/** `node.calendar.create_event` → its matrix row, or undefined for other tools. */
export function appleAppAction(tool: string): AppleAppAction | undefined {
  if (!tool.startsWith("node.")) return undefined;
  return APPLE_APP_ACTIONS[tool.slice(5)];
}

/** Connector key for the engine's matrix lookup. */
export function appleAppConnector(tool: string): { id: string; action: string } | undefined {
  const a = appleAppAction(tool);
  return a === undefined ? undefined : { id: a.connector, action: a.action };
}

/**
 * The matrix effect for an Apple app call: the owner's entry, else the default; an `alwaysAsk`
 * action downgrades an owner `allow` to `ask`.
 */
export function appleAppEffect(
  tool: string,
  configured: "allow" | "ask" | "deny" | undefined,
): "allow" | "ask" | "deny" | undefined {
  const a = appleAppAction(tool);
  if (a === undefined) return configured;
  const effect = configured ?? a.default;
  return a.alwaysAsk === true && effect === "allow" ? "ask" : effect;
}
