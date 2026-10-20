/** The chat column: thread, composer, message actions, follow-up queue (`chat/`). */
export const chat = {
  "chat.command.failed": "/{name} didn't work ({reason}). Nothing was changed.",
  "chat.command.newerGateway": "This needs a newer Gateway.",
  "chat.command.didntWork": "That didn't work ({reason}). Nothing was changed.",
  "chat.command.modelCurrent":
    "This thread uses {model}. Type /model provider/model to pick another.",
  "chat.command.defaultModel": "the default model",
  "chat.command.modelSet": "This thread now uses {model}.",
  "chat.command.planMode": "Plan mode: read-only until you switch back.",
  "chat.command.noted": "Noted in {path}.",
  "chat.command.nothingMatches": 'Nothing remembered matches "{subject}".',
  "chat.command.forgetPreview":
    'Forgetting "{subject}" retracts {claims, plural, one {# claim} other {# claims}} and {chunks, plural, one {# indexed note} other {# indexed notes}}{hasFiles, select, true {, editing {files}} other {}}.',
  "chat.command.forget": "Forget",
  "chat.command.forgot": 'Forgot "{subject}".',
  "chat.command.forgetFailed": "Forgetting didn't work ({reason}). Nothing was changed.",
  "chat.command.status.model": "Model: {model}",
  "chat.command.status.default": "default",
  "chat.command.status.mode": "Mode: {mode}",
  "chat.command.status.chat": "This chat: {state, select, working {working} other {idle}}",
  "chat.command.status.tasks": "Running tasks: {n, number}",
  "chat.command.exported": "Exported this thread as {format}.",
  "chat.command.nothingRunning": "Nothing is running in this chat.",
  "chat.command.stopped": "Stopped.",
} as const;
