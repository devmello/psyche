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
  /**
   * The Settings → Connectors action group (`mail.organize`), the key the owner's matrix uses for
   * this app's connector (#747). Mirrors the connector tool specs in `@psyche/connectors`
   * (`packages/connectors/src/apple/connector.ts`); the Gateway test fails when they drift.
   */
  group: string;
  sideEffect: SideEffect;
  kind: ApprovalKind;
  default: "allow" | "ask" | "deny";
  alwaysAsk?: true;
}

const read = (connector: AppleAppAction["connector"], action: string): AppleAppAction => ({
  connector,
  action,
  group: "",
  sideEffect: "read",
  kind: "connector_action",
  default: "allow",
});

const write = (
  connector: AppleAppAction["connector"],
  action: string,
  kind: ApprovalKind = "connector_action",
  extra: Partial<AppleAppAction> = {},
): AppleAppAction => ({
  connector,
  action,
  group: "",
  sideEffect: "write",
  kind,
  default: "ask",
  ...extra,
});

/**
 * Action group per capability (the connector specs' `action`). Capabilities without a connector
 * tool (Finder, opening a page in Safari) get a group of their own.
 */
const GROUPS: Readonly<Record<string, string>> = {
  "calendar.create_event": "calendar.write",
  "calendar.update_event": "calendar.write",
  "calendar.delete_event": "calendar.delete",
  "calendar.free_busy": "calendar.read",
  "calendar.list_calendars": "calendar.read",
  "calendar.list_events": "calendar.read",
  "chrome.current_tab": "chrome.read",
  "chrome.tabs": "chrome.read",
  "contacts.create": "contacts.write",
  "contacts.update": "contacts.write",
  "contacts.read": "contacts.read",
  "contacts.search": "contacts.read",
  "files.move": "files.organize",
  "files.rename": "files.organize",
  "files.trash": "files.trash",
  "files.recent": "files.read",
  "finder.list": "finder.read",
  "finder.reveal": "finder.read",
  "mail.draft": "mail.draft",
  "mail.reply_draft": "mail.draft",
  "mail.forward_draft": "mail.draft",
  "mail.mailboxes": "mail.read",
  "mail.read": "mail.read",
  "mail.search": "mail.read",
  "mail.selected": "mail.read",
  "mail.move": "mail.organize",
  "mail.set_flags": "mail.organize",
  "mail.save_attachments": "mail.organize",
  "mail.send": "mail.send",
  "mail.send_draft": "mail.send",
  "music.control": "music.control",
  "music.play": "music.control",
  "music.now_playing": "music.read",
  "music.search_library": "music.read",
  "notes.append": "notes.edit",
  "notes.update": "notes.edit",
  "notes.create": "notes.create",
  "notes.folders": "notes.read",
  "notes.list": "notes.read",
  "notes.read": "notes.read",
  "notes.search": "notes.read",
  "reminders.complete": "reminders.write",
  "reminders.create": "reminders.write",
  "reminders.set_flagged": "reminders.write",
  "reminders.update": "reminders.write",
  "reminders.delete": "reminders.delete",
  "reminders.list": "reminders.read",
  "reminders.list_lists": "reminders.read",
  "safari.add_reading_list": "safari.write",
  "safari.current_tab": "safari.read",
  "safari.tab_text": "safari.read",
  "safari.tabs": "safari.read",
  "safari.open_url": "safari.open",
  "shortcuts.list": "shortcuts.read",
  "shortcuts.run": "shortcuts.run",
  "things.add": "things.write",
  "things.complete": "things.write",
  "things.update": "things.write",
  "things.list": "things.read",
};

const ROWS: Readonly<Record<string, AppleAppAction>> = {
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
  // Things 3 through the same helper route (wave 1, §5; #639).
  "things.list": read("apple.things", "list"),
  "things.add": write("apple.things", "add"),
  "things.update": write("apple.things", "update"),
  "things.complete": write("apple.things", "complete"),
  // Shortcuts (wave 1, §4.9; #639): a run's side effect is unknown, so it is destructive.
  "shortcuts.list": read("apple.shortcuts", "list"),
  "shortcuts.run": write("apple.shortcuts", "run", "connector_action", {
    sideEffect: "destructive",
  }),
  // Files in granted folders (wave 1, §4.8; #639).
  "files.recent": read("apple.files", "recent"),
  "files.move": write("apple.files", "move"),
  "files.rename": write("apple.files", "rename"),
  "files.trash": write("apple.files", "trash", "connector_action", { sideEffect: "destructive" }),
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

/** Keyed by helper capability name (without the `node.` prefix). */
export const APPLE_APP_ACTIONS: Readonly<Record<string, AppleAppAction>> = Object.fromEntries(
  Object.entries(ROWS).map(([cap, row]) => [cap, { ...row, group: GROUPS[cap] ?? cap }]),
);

/** `node.calendar.create_event` → its matrix row, or undefined for other tools. */
export function appleAppAction(tool: string): AppleAppAction | undefined {
  if (!tool.startsWith("node.")) return undefined;
  return APPLE_APP_ACTIONS[tool.slice(5)];
}

/**
 * Connector key for the engine's matrix lookup: the app's `apple.<app>` key and the action group
 * (the owner's Settings → Connectors rules land there, #747). A `policy.connectors` entry under
 * the bare action name (`apple.mail` / `set_flags`) still applies when the group has none.
 */
export function appleAppConnector(tool: string): { id: string; action: string } | undefined {
  const a = appleAppAction(tool);
  return a === undefined ? undefined : { id: a.connector, action: a.group };
}

/** Settings → Connectors record type (`apple:mail`, `chrome:tabs`, `things`) → its `apple.<app>` key. */
export function appleConnectorKey(recordType: string): `apple.${string}` | undefined {
  if (recordType.startsWith("apple:")) return `apple.${recordType.slice(6)}`;
  if (recordType === "chrome:tabs") return "apple.chrome";
  if (recordType === "things") return "apple.things";
  return undefined;
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
