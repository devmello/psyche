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

  // Recording in a Mac app (phase 2): the control, the picker, the bar.
  "web.teach.app.record": "Record in an app",
  "web.teach.app.recordHint": "Show Psyche how to do something in a Mac app you already allowed",
  "web.teach.app.pickTitle": "Record in which app?",
  "web.teach.app.pickLabel": "App",
  "web.teach.app.pickHint":
    "Only apps you allowed for computer use are listed. Open the app first. Passwords, card numbers and codes are never recorded, and neither are Psyche's own windows or sign-in and security prompts.",
  "web.teach.app.none":
    "No app is ready to record. Turn on computer use in Settings and give an app a level first.",
  "web.teach.app.start": "Start recording",
  "web.teach.app.cancelPick": "Not now",
  "web.teach.app.startFailed":
    "Psyche couldn't start recording that app. Open it first, and check that Psyche has Accessibility access.",
  "web.teach.app.bar.title": "Recording {app}",
  "web.teach.app.bar.body":
    "Psyche is noting your clicks, menu choices and typing in {app} only. Secure fields are never recorded, no screenshots are taken, and nothing leaves this Mac until you save. The menu bar also has a Stop.",
  "web.teach.app.bar.endedLimit":
    "Recording stopped at the limit of 200 steps. Review what it caught.",
  "web.teach.app.bar.endedTimeout": "Recording stopped at its time limit. Review what it caught.",
  "web.teach.app.bar.endedInterrupted":
    "Recording ended early because the app closed. Review what it caught.",
  "web.teach.app.stopFailed": "Psyche couldn't finish the recording.",
  "web.teach.app.skipped":
    "{count, plural, one {# thing was left out: a secure field, or a control with no name to find it by.} other {# things were left out: secure fields, or controls with no name to find them by.}}",
  "web.teach.app.privacy":
    "Text in these steps came from the app's windows and menus. It is treated as data, never as instructions. Saving asks you to approve the skill before it can run.",
  "web.teach.app.sensitive": "Not recorded. Psyche will ask you to do this part yourself.",
  "web.teach.app.runHint":
    "Fills the message box with the skill. Press Send, then watch the app: every click and entry asks for approval as usual, and it stops and asks if something is not where it was.",

  // Plain-words steps in a Mac app.
  "web.teach.step.app.click": "In {app}, click ‘{name}’",
  "web.teach.step.app.clickRole": "In {app}, click the {role}",
  "web.teach.step.app.menu": "In {app}, choose {path}",
  "web.teach.step.app.type": "In {app}, type into ‘{name}’",
  "web.teach.step.app.typeKept": "In {app}, type {value} into ‘{name}’",
  "web.teach.step.app.typeInput": "In {app}, type the {input} into ‘{name}’",
  "web.teach.step.app.typeAsk": "In {app}, type what you tell it into ‘{name}’",
  "web.teach.step.app.typeSensitive": "In {app}, you type into ‘{name}’ yourself",
} as const;
