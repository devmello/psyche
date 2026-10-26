/** The output canvas (`canvas/`; docs/design/chat-experience-2026.md §4.2). */
export const canvas = {
  "canvas.chart": "Chart",
  "canvas.label": "Canvas: {title}",
  "canvas.recents": "Recent outputs",
  "canvas.loading": "Loading…",
  "canvas.missing": "Psyche couldn't load this output.",
  "canvas.untrusted": "From untrusted content",
  "canvas.version": "Version",
  "canvas.versionOption":
    "v{version} · {author, select, user {you} specialist {specialist} other {Psyche}} · {time}",
  "canvas.copy": "Copy",
  "canvas.copied": "Copied",
  "canvas.download": "Download",
  "canvas.restore": "Restore as new version",
  "canvas.oldVersion": "Viewing version {version} (read-only).",
  "canvas.conflict":
    "This changed while you were editing, so your edit wasn't saved. Try again on the latest version.",
  "canvas.saveFailed": "Couldn't save: {message}",
} as const;
