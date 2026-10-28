/**
 * The capability catalogue in Settings (Connectors and Skills "Available" lists, the loading
 * choice on a connector) and the install approval card.
 */
export const capabilities = {
  "settings.key.capabilities.onlineSearch": "Search the online MCP registry",
  "settings.key.tools.loading": "When tools are loaded",
  "capabilities.available.title": "Available",
  "capabilities.available.connectorsHint":
    "Ready-made and registry connectors you can add. Nothing runs until you approve it.",
  "capabilities.available.skillsHint": "Skills that are installed but switched off.",
  "capabilities.search.label": "Search available connectors",
  "capabilities.search.skillsLabel": "Search available skills",
  "capabilities.loadFailed": "Could not search: {reason}",
  "capabilities.noConnectors": "No connectors match.",
  "capabilities.noSkills": "No skills are switched off.",
  "capabilities.online.label": "Let Psyche search the online MCP registry",
  "capabilities.online.hint":
    "Off by default. When on, your search words are sent to the official MCP registry.",
  "capabilities.badge.official": "Official",
  "capabilities.badge.unverified": "Unverified",
  "capabilities.badge.registry": "From the MCP registry",
  "capabilities.needs.key": "Needs a key",
  "capabilities.needs.oauth": "Needs you to sign in",
  "capabilities.needs.sandbox": "Runs in the sandbox",
  "capabilities.needs.remote": "Runs on a remote server",
  "capabilities.needs.network": "Reaches {hosts}",
  "capabilities.action.setUp": "Set up",
  "capabilities.action.check": "Check server",
  "capabilities.action.turnOn": "Turn on",
  "capabilities.action.needsKey":
    "Needs a key or sign-in. Add it from the connector gallery or the JSON form.",
  "capabilities.loading.title": "When Psyche loads it",
  "capabilities.loading.label": "Always on",
  "capabilities.loading.hint":
    "On demand, Psyche finds this connector's tools when a task needs them. Always on sends them with every request.",
  "capabilities.loading.failed": "Could not change this: {reason}",
  "capabilities.card.source": "Source",
  "capabilities.card.kind.connector": "Connector",
  "capabilities.card.kind.skill": "Skill",
  "capabilities.card.trust": "Trust",
  "capabilities.card.command": "Command",
  "capabilities.card.url": "Address",
  "capabilities.card.network": "Network",
  "capabilities.card.permissions": "Permissions",
  "capabilities.card.summary": "What it does",
  "capabilities.card.reason": "Why",
  "capabilities.card.warning": "Not verified",
  "capabilities.card.tainted": "Caution",
} as const;
