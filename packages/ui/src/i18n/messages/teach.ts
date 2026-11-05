/** Teach by showing in the built-in browser (docs/design/teach-by-showing-2026.md). */
export const teach = {
  // The pane: Record, the recording bar, kept recordings.
  "web.teach.record": "Record",
  "web.teach.recordHint": "Show Psyche how to do something in this tab",
  "web.teach.agentTab": "The agent is using this tab. Open your own tab to record.",
  "web.teach.startFailed": "Psyche couldn't start recording this tab.",
  "web.teach.bar.title": "Recording",
  "web.teach.bar.body":
    "Psyche is noting your clicks and typing in this tab only. Passwords, card numbers and codes are never recorded, and nothing leaves this Mac until you save.",
  "web.teach.bar.steps": "{count, plural, one {# step} other {# steps}} so far",
  "web.teach.bar.stop": "Stop recording",
  "web.teach.bar.cancel": "Discard",
  "web.teach.bar.endedLimit": "Recording stopped at the limit of 200 steps. Review what it caught.",
  "web.teach.bar.endedInterrupted":
    "Recording ended early because the tab changed or closed. Review what it caught.",
  "web.teach.bar.review": "Review",
  "web.teach.stopFailed": "Psyche couldn't finish the recording.",
  "web.teach.nothingRecorded": "Nothing was recorded.",

  // Settings → Browser: where kept recordings go.
  "settings.teach.storage.title": "Recordings you keep",
  "settings.teach.storage.description":
    "When you ask Psyche to keep a recording so you can make another version, the steps are saved on this Mac.",
  "settings.teach.storage.encrypted":
    "Encrypted. The file is locked with a key held in this Mac's keychain, so it cannot be read outside Psyche. It expires after 90 days.",
  "settings.teach.storage.unavailable":
    "Recordings are not kept. This Mac's keychain is not available, and Psyche will not save a recording as plain text. You can still save a recording as a skill.",
  "web.teach.review.keepUnavailable":
    "Not available: this Mac's keychain is not available to encrypt a kept recording.",

  "web.teach.kept.title": "Kept recordings",
  "web.teach.kept.open": "Open",
  "web.teach.kept.delete": "Delete",
  "web.teach.kept.deleted": "Recording deleted.",
  "web.teach.kept.failed": "Psyche couldn't open that recording.",

  // The review screen.
  "web.teach.review.title": "Review what you showed",
  "web.teach.review.intro":
    "These are the steps Psyche caught, in plain words. Fix, reorder or remove any of them. Nothing is saved until you press Save.",
  "web.teach.review.name": "What should this be called?",
  "web.teach.review.namePlaceholder": "Export the weekly billing report",
  "web.teach.review.skipped":
    "{count, plural, one {The page changed itself # time while you recorded. That is left out.} other {The page changed itself # times while you recorded. Those are left out.}}",
  "web.teach.review.steps": "Steps",
  "web.teach.review.stepNumber": "Step {n}",
  "web.teach.review.moveUp": "Move step {n} up",
  "web.teach.review.moveDown": "Move step {n} down",
  "web.teach.review.remove": "Remove step {n}",
  "web.teach.review.empty": "Every step was removed. Cancel, or record again.",
  "web.teach.review.sensitive":
    "Not recorded. Psyche will hand you the tab to do this part yourself.",
  "web.teach.review.value": "What to type",
  "web.teach.review.value.ask": "Ask me each time",
  "web.teach.review.value.keep": "Keep this value",
  "web.teach.review.value.input": "Make it an input",
  "web.teach.review.valueHidden": "The example you typed is hidden and will not be saved.",
  "web.teach.review.valueKept": "Saved with the skill: {value}",
  "web.teach.review.inputName": "Input name",
  "web.teach.review.inputDescription": "What it is",
  "web.teach.review.inputDescriptionPlaceholder": "The first day of the week",
  "web.teach.review.keepRecording": "Keep this recording on this Mac so I can make another version",
  "web.teach.review.keepRecordingHint":
    "Only the steps above are kept, with the values you chose to keep. Otherwise the recording is deleted when you save.",
  "web.teach.review.save": "Save as a skill",
  "web.teach.review.saving": "Saving",
  "web.teach.review.discard": "Discard recording",
  "web.teach.review.privacy":
    "Page text in these steps is treated as data, never as instructions. Saving asks you to approve the skill before it can run.",
  "web.teach.review.issues": "Fix this first: {problems}",
  "web.teach.review.needName": "Give it a name first.",
  "web.teach.review.saveFailed": "Psyche couldn't save this as a skill: {reason}",

  // After saving.
  "web.teach.done.title": "Saved",
  "web.teach.done.body":
    "“{title}” is waiting for your approval. Read the card, then approve it to install the skill.",
  "web.teach.done.installed": "“{title}” is installed.",
  "web.teach.done.run": "Run it once now",
  "web.teach.done.runHint":
    "Fills the message box with the skill. Press Send, then watch the browser: every click and entry asks for approval as usual, and it stops and asks if the page has changed.",
  "web.teach.done.close": "Close",

  // Plain-words steps.
  "web.teach.step.navigate": "Open {address}",
  "web.teach.step.click": "Click ‘{name}’",
  "web.teach.step.clickRole": "Click the {role}",
  "web.teach.step.type": "Type into ‘{name}’",
  "web.teach.step.typeKept": "Type {value} into ‘{name}’",
  "web.teach.step.typeInput": "Type the {input} into ‘{name}’",
  "web.teach.step.typeAsk": "Type what you tell it into ‘{name}’",
  "web.teach.step.typeSensitive": "You type into ‘{name}’ yourself",
  "web.teach.step.typeUnnamed": "a field",
  "web.teach.step.select": "Choose an option in ‘{name}’",
  "web.teach.step.selectKept": "Choose {value} in ‘{name}’",
  "web.teach.step.selectInput": "Choose the {input} in ‘{name}’",
  "web.teach.step.selectAsk": "Choose what you tell it in ‘{name}’",
  "web.teach.step.selectSensitive": "You choose in ‘{name}’ yourself",
  "web.teach.step.press": "Press {key}",
  "web.teach.step.pressIn": "Press {key} in ‘{name}’",
} as const;
