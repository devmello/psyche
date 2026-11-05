/**
 * Platform words (`lib/platform-copy.ts`, `platformTerm()`) and the few messages only one
 * platform shows. The English here is the macOS wording; Windows has its own in
 * `variants/windows.ts`, which `t()` uses on Windows for any id it lists.
 */
export const platform = {
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "This Mac",
  "platform.term.thisDeviceLower": "this Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Keychain",
  "platform.term.systemSettings": "System Settings",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "menu bar",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "Mac helper",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Option",
  "platform.term.mod": "Command",
  // A capability only a Mac has, on another platform (cross-platform-2026 §4.3): never a failure.
  "platform.macOnly": "Available on macOS",
  "platform.macOnlyHint": "{name} needs a Mac. Psyche on macOS can use it.",

  // Windows access (Settings → Computer use, onboarding's Safety step): what Windows asks for.
  "platform.windows.access.title": "Windows access",
  "platform.windows.access.hint": "What Windows lets Psyche do, and what it asks you for.",
  "platform.windows.access.noPermission": "No permission needed",
  "platform.windows.access.uiAutomation.name": "Using apps",
  "platform.windows.access.uiAutomation.why":
    "{persona} reads and uses app windows through Windows UI Automation. Windows doesn't let it control apps that run as administrator.",
  "platform.windows.access.screen.name": "Screen capture",
  "platform.windows.access.screen.why":
    "Windows needs no permission to capture the screen. Psyche's own windows and password fields are hidden from captures.",
  "platform.windows.access.microphone.name": "Microphone",
  "platform.windows.access.microphone.why":
    "For dictation and meeting notes. Windows asks under Settings → Privacy & security → Microphone, with “Let desktop apps access your microphone” on.",
  "platform.windows.access.openSettings": "Open Settings",
  "platform.windows.access.openSettingsFor": "Open Windows Settings for {name}",
  "platform.windows.access.state.granted": "On",
  "platform.windows.access.state.denied": "Off in Windows Settings",
  "platform.windows.access.state.not_determined": "Not checked yet",

  // The bundled helper's status row (Mac helper or Windows helper): start it again by hand.
  "platform.helper.restart": "Restart helper",
  "platform.helper.restarting": "Restarting…",
  "platform.helper.restartFailed": "The helper didn't start ({reason}).",
} as const;
