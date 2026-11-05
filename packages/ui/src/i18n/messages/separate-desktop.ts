/**
 * Settings > Computer use > Separate desktop (docs/design/linux-desktop-2026.md section 8): the
 * container desktop's state, memory limit and reset.
 */
export const separateDesktop = {
  "settings.separateDesktop.title": "Separate desktop",
  "settings.separateDesktop.description":
    "A private desktop in a container, with its own apps and files. It sees only the folders you share for a task, has no internet unless you allow it for that task, and stops when the task ends.",
  "settings.separateDesktop.state.off": "Not running",
  "settings.separateDesktop.state.starting": "Starting",
  "settings.separateDesktop.state.running": "Running",
  "settings.separateDesktop.state.stopping": "Stopping",
  "settings.separateDesktop.state.failed": "Could not start",
  "settings.separateDesktop.engine": "Container engine: {engine}",
  "settings.separateDesktop.rootful":
    "This container engine runs as root. Use rootless Podman for the separate desktop.",
  "settings.separateDesktop.memory": "Memory limit",
  "settings.separateDesktop.memoryHint":
    "The most memory the separate desktop may use while it runs.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "Shared folders: {names}",
  "settings.separateDesktop.internet": "Internet is on for this task",
  "settings.separateDesktop.reset": "Reset separate desktop",
  "settings.separateDesktop.resetHint":
    "Deletes its container and everything saved inside it. Folders you shared are not touched.",
} as const;
