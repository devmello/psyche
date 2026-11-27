/**
 * Onboarding's finish, the recovery key's new home and "Make these searchable" (simplify batch
 * B3): the Done step, Home's "Save your recovery key" card, the key's view in Settings →
 * Credentials, and the connectors step's search switch. Merged into the catalogues like the other
 * areas.
 */
export const simplifyB3 = {
  "onboarding.done.start": "Start chatting",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait":
    "Psyche can't be reached right now. This window reconnects on its own.",
  "onboarding.done.helperWait":
    "Psyche Helper hasn't connected yet. Computer use and notifications start once it does.",
  "onboarding.connectors.searchable": "Make these searchable",
  "onboarding.connectors.searchableHint":
    "{name} can find mail, events and notes from these accounts in Search. You can turn any off in Settings.",
  "home.recoveryKey.title": "Save your recovery key",
  "home.recoveryKey.body":
    "It is the only way back into your vault after a restore or a lost key. Show it, keep a copy somewhere safe, then confirm.",
  "settings.credentials.vault.recoveryKey.show": "Show recovery key",
  "settings.credentials.vault.recoveryKey.hide": "Hide",
  "settings.credentials.vault.recoveryKey.gone":
    "This vault's recovery key was only shown when the vault was created, so it can't be shown again.",
  "settings.credentials.vault.recoveryKey.failed": "Couldn't show the recovery key: {reason}",
  "settings.credentials.vault.recoveryKey.title": "Recovery key",
  "settings.credentials.vault.recoveryKey.body":
    "The only way back into the vault after a restore or a lost key. Keep a copy somewhere safe.",
} as const;
