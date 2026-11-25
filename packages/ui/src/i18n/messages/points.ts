/**
 * Psyche points, you click (docs/design/psyche-points-2026.md §9): the start sheet, the Chat offer
 * card, the ⌘K action, Settings → Computer use → Psyche points and the helper's own card text
 * (`points.card.*`, sent to the helper in `PointsCardStrings` at Start).
 */
export const points = {
  "points.sheet.title": "Point me through a form",
  "points.sheet.description":
    "Pick a window and Psyche points at the next field to fill. You do the clicking and typing.",
  "points.sheet.windows.label": "Window",
  "points.sheet.windows.loading": "Looking for windows…",
  "points.sheet.windows.empty": "No windows to point at. Open the form, then try again.",
  "points.sheet.windows.error":
    "Couldn't list your windows. Check that Psyche Helper is running, then try again.",
  "points.sheet.windows.retry": "Try again",
  "points.sheet.window.untitled": "Untitled window",
  "points.sheet.window.frontmost": "In front",
  "points.refusal.never_app": "Psyche doesn't point in this app.",
  "points.refusal.fixed_off": "This app is off limits for Psyche.",
  "points.refusal.terminal_or_ide": "Terminals and code editors aren't forms.",
  "points.refusal.owner_off": "You turned this app off in Settings.",
  "points.refusal.not_a_window": "Psyche can't read this window.",
  "points.refusal.permission_missing": "Allow Accessibility to read this window.",
  "points.sheet.goal.label": "What is this form for? (optional)",
  "points.sheet.goal.placeholder": "2026 tax return, married filing jointly",
  "points.sheet.data.provider":
    "Psyche sends this form's labels and what you type, except passwords, card, bank and ID numbers, to {provider} to guide you.",
  "points.sheet.data.local": "This stays on this computer.",
  "points.sheet.data.providerFallback": "your model provider",
  "points.sheet.payments":
    "On payment pages Psyche only gives directions. You fill those fields yourself.",
  "points.sheet.permission.hint":
    "Psyche reads the window through Accessibility. Allow it for Psyche Helper to start.",
  "points.sheet.start": "Start pointing",
  "points.sheet.starting": "Starting…",
  "points.sheet.cancel": "Cancel",
  "points.sheet.startFailed": "Couldn't start pointing. Try again.",
  "points.sheet.session.active": "Pointing in {app}",
  "points.sheet.session.stop": "Stop pointing",
  "points.state.reading": "Reading the form…",
  "points.state.pointing": "Field {step} of {of}",
  "points.state.paused": "Paused",
  "points.needs.screenRecording.title": "Let Psyche look needs Screen Recording",
  "points.needs.screenRecording.hint":
    "Psyche sends a picture of this window only when you press Let Psyche look.",
  "points.needs.done": "Done",
  "points.offer.button": "Point me through it",
  "points.offer.hint": "Psyche shows where to look. You click and type.",
  "points.offer.elsewhere":
    "Start Psyche points on the computer where Psyche runs: press {keys}, then choose Point me through a form.",
  "points.palette.start": "Point me through a form",
  "points.palette.keywords":
    "psyche points arrow guide walk through form fill taxes visa paperwork",
  "points.settings.title": "Psyche points",
  "points.settings.description":
    "Pick a window and Psyche points at the next field to fill. It never clicks or types.",
  "points.settings.enabledHint": "Adds Point me through a form to the command palette.",
  "settings.key.points.enabled": "Point me through forms",
  "points.card.back": "Back",
  "points.card.skip": "Skip",
  "points.card.next": "Next",
  "points.card.looksWrong": "Looks wrong?",
  "points.card.stuck": "Stuck?",
  "points.card.stuckMissing": "I don't have this",
  "points.card.stuckUnclear": "I don't get this",
  "points.card.stuckBlocked": "It won't let me",
  "points.card.askInPsyche": "Ask in Psyche…",
  "points.card.letLook": "Let Psyche look",
  "points.card.stop": "Stop",
  "points.card.hideNote": "Hide note",
  "points.card.copy": "Copy",
  "points.card.selfFill": "You fill this yourself: {label}",
  "points.card.selfFillPlain": "You fill this yourself",
  "points.card.payButton": "This button pays. Check the amount, then decide yourself.",
  "points.card.unknownValue": "Psyche doesn't know this one.",
  "points.card.scrollTo": "Scroll down to {label}",
  "points.card.menuBarTitle": "◉ Pointing: {app}",
  "points.card.stepFormat": "{n}/{total}",
  "points.card.visionBadge": "Using a picture of this window",
  "points.card.followWindow": "Follow this window",
} as const;
