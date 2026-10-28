/** Connectors Psyche wrote for itself: the badge, its code viewer/editor, and the approval card. */
export const selfConnectors = {
  "settings.mcp.madeBy": "Made by Psyche",
  "settings.mcp.madeByHint":
    "Psyche wrote this connector's code. It runs only in the sandbox, only the code you approved, and its tools ask before changing anything.",
  "settings.mcp.code.title": "Code",
  "settings.mcp.code.view": "View code",
  "settings.mcp.code.hide": "Hide code",
  "settings.mcp.code.loading": "Loading the code…",
  "settings.mcp.code.version": "Version {version} · {runtime} · starts {entry}",
  "settings.mcp.code.modified":
    "The code on disk is not the version you approved, so this connector is stopped until you approve the change.",
  "settings.mcp.code.file": "{path} · {bytes} B",
  "settings.mcp.code.edit": "Edit {file}",
  "settings.mcp.code.editing": "Editing {file}",
  "settings.mcp.code.save": "Save for review",
  "settings.mcp.code.saving": "Saving…",
  "settings.mcp.code.cancel": "Cancel editing",
  "settings.mcp.code.provided": "Provided by Psyche, the same for every connector",
  "settings.mcp.code.approved": "{name} updated.",
  "settings.mcp.code.denied":
    "Change to {name} not approved. It stays stopped until you approve one.",
  "blocks.details.connector.runtime": "Runs",
  "blocks.details.connector.runtimeValue": "{persona} wrote this connector (version {version})",
  "blocks.details.connector.command": "Command",
  "blocks.details.connector.network": "Asks to reach",
  "blocks.details.connector.networkNone": "No network",
  "blocks.details.connector.tools": "Tools",
  "blocks.details.connector.files": "Code ({n} files)",
  "blocks.details.connector.file": "{path} ({bytes} bytes)",
  "blocks.details.connector.provided": "provided by Psyche",
  "blocks.details.connector.diff": "Changes since version {version}",
  "blocks.details.connector.suggested": "{persona} suggests this connector from the registry",
} as const;
