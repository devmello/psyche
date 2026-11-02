/**
 * The Connectors pane (Settings → Connectors & sources → Connectors): one list of what is
 * connected, what needs the owner, what is on this Mac and what can be added. A row opens a
 * detail view; custom servers sit under Advanced. Plain words: no protocol names on the first
 * screen.
 */
export const connectorsPage = {
  "settings.connectors.page.description":
    "The apps and tools {persona} can use. Each one asks before it acts, unless you say otherwise.",
  "settings.connectors.page.needsYou": "Needs you",
  "settings.connectors.page.connected": "Connected",
  "settings.connectors.page.onThisMac": "On this Mac",
  "settings.connectors.page.addMore": "Add more",
  "settings.connectors.page.addMore.hint":
    "Mail, calendar, notes and ready-made tools. Each one asks before it acts.",
  "settings.connectors.page.addMore.browse": "Browse all",
  "settings.connectors.page.status.paused": "Paused",
  "settings.connectors.page.status.notWorking": "Not working",
  "settings.connectors.page.status.signInExpired": "Sign-in expired",
  "settings.connectors.page.status.on": "On",
  "settings.connectors.page.status.off": "Off",
  "settings.connectors.page.paused": "Paused",
  "settings.connectors.page.open": "Open {name}",
  "settings.connectors.page.manage": "Manage",
  "settings.connectors.page.fix.seeWhy": "See why",
  "settings.connectors.page.row.never": "Not used yet",
  "settings.connectors.page.row.lastUsed": "Used {when}",
  "settings.connectors.page.row.unverified": "Unverified",
  "settings.connectors.page.row.local": "Runs on this Mac",
  "settings.connectors.page.row.remote": "Connects over the web",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {No folders shared} one {1 folder shared} other {# folders shared}}",
  "settings.connectors.page.row.terminal.on": "Can run commands",
  "settings.connectors.page.row.terminal.off": "Commands are off",
  "settings.connectors.page.detail.label": "{name} details",
  "settings.connectors.page.detail.about": "About",
  "settings.connectors.page.detail.access": "Access",
  "settings.connectors.page.detail.source": "Source",
  "settings.connectors.page.detail.technical": "Technical details",
  "settings.connectors.page.detail.manage": "Pause or remove",
  "settings.connectors.page.detail.type": "Type",
  "settings.connectors.page.detail.removeHint":
    "Disconnect pauses it and keeps its settings. Remove deletes it.",
  "settings.connectors.page.source.builtIn": "Built into Psyche",
  "settings.connectors.page.source.verified": "Verified publisher",
  "settings.connectors.page.source.unverified": "Not checked by anyone yet",
  "settings.connectors.page.attention.signIn":
    "Your sign-in with {name} ran out. Sign in again so it can keep working.",
  "settings.connectors.page.attention.error":
    "{name} isn't working right now. Try signing in again; if it keeps failing, remove it and add it back.",
  "settings.connectors.page.attention.errorReason": "What it said: {reason}",
  "settings.connectors.page.attention.server":
    "{name} didn't start, so its tools aren't available.",
  "settings.connectors.page.attention.serverHint":
    "Check its command or address and any secrets below, then turn it off and on again.",
  "settings.connectors.page.server.local": "A tool that runs in a sandbox on this Mac",
  "settings.connectors.page.server.remote": "A tool you reach by web address",
  "settings.connectors.page.server.network": "Reaches the network",
  "settings.connectors.page.server.noNetwork": "No network",
  "settings.connectors.page.advanced": "Advanced",
  "settings.connectors.page.advanced.hint":
    "Your own tool servers, and a search of the public registry.",
  "settings.connectors.page.advanced.custom": "Your own tool server",
  "settings.connectors.page.advanced.customHint":
    "Run any MCP server in the sandbox, or connect to one by web address.",
  "settings.connectors.page.advanced.customAction": "Add server",
  "settings.connectors.page.advanced.find": "Find servers online",
  "settings.connectors.page.gallery.title": "Add a connector",
  "settings.connectors.page.gallery.intro":
    "Pick something to try. Each one asks before it does anything, and you can remove it any time.",
  "settings.connectors.page.gallery.noMatch": "Nothing matches. Try another word.",
  "settings.connectors.page.gallery.back": "Back to the gallery",
  "settings.connectors.page.gallery.community": "Community",
} as const;
