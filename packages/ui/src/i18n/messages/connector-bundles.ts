/**
 * Shared connectors and author keys (docs/design/shared-bundles-2026.md): the `.psyche-connector`
 * card, importing and sharing a connector, replacing the author key and revocation notices.
 */
export const connectorBundles = {
  // --- the card ---
  "settings.connectorBundle.title": "Shared connector {name}",
  "settings.connectorBundle.intro":
    "Someone shared this connector as a file. Nothing is installed yet. Check who made it and what it asks for, then decide.",
  "settings.connectorBundle.update": "This is an update to the connector you have.",
  "settings.connectorBundle.signer.title": "Who made it",
  "settings.connectorBundle.signer.unsigned":
    "This file is not signed, so there is no way to tell who made it.",
  "settings.connectorBundle.signer.dropped": "The installed version was signed. This one is not.",
  "settings.connectorBundle.signer.new": "Signed by {name}. You have not seen this key before.",
  "settings.connectorBundle.signer.seen":
    "Signed by {name}, a key you have seen before but do not trust.",
  "settings.connectorBundle.signer.trusted": "Signed by {name}, an author you trust.",
  "settings.connectorBundle.signer.own": "Signed by you.",
  "settings.connectorBundle.signer.changed":
    "Signed by {name}, but not with the key seen before. Check that it is the same person.",
  "settings.connectorBundle.signer.impersonates":
    "Signed under a name that looks like yours, with a key that is not yours.",
  "settings.connectorBundle.signer.nameChanged":
    "A key you trust is signing under a name it has not used before: {name}.",
  "settings.connectorBundle.signer.revoked": "Signed by a key you revoked.",
  "settings.connectorBundle.signer.rotated":
    "Signed by {name}: same author, new key (signed by the old key). The new key is not trusted until you trust it.",
  "settings.connectorBundle.signer.claim":
    "The name is the author's own claim. Only the key identifies them.",
  "settings.connectorBundle.signer.key": "Author key",
  "settings.connectorBundle.signer.trust": "Trust {name} as an author",
  "settings.connectorBundle.signer.trustHint":
    "This only changes the label and the warnings on later files. It never skips this card.",
  "settings.connectorBundle.command": "Command it runs",
  "settings.connectorBundle.commandHint":
    "Program first, then each argument on its own line. It is not run through a shell.",
  "settings.connectorBundle.network": "Network it asks for",
  "settings.connectorBundle.noNetwork": "No network",
  "settings.connectorBundle.networkHint":
    "Only the sandbox can enforce this. The list is what the author says.",
  "settings.connectorBundle.env": "Variables it reads",
  "settings.connectorBundle.noEnv": "None",
  "settings.connectorBundle.envHint": "Names only. You give them values after installing.",
  "settings.connectorBundle.secrets": "Secrets it needs",
  "settings.connectorBundle.noSecrets": "None",
  "settings.connectorBundle.secretsHint":
    "Names only. The file carries no secret. After installing you give each one a value, and it is kept in your vault.",
  "settings.connectorBundle.tools": "Tools the author says it lists",
  "settings.connectorBundle.toolsCount": "{n, plural, one {# tool} other {# tools}}",
  "settings.connectorBundle.toolsHint":
    "Psyche starts it in the sandbox and lists what it really offers. Those tools are the ones that count.",
  "settings.connectorBundle.toolsUndeclared":
    "The server listed tools the file did not declare: {names}",
  "settings.connectorBundle.toolsMissing":
    "The file declared tools the server did not list: {names}",
  "settings.connectorBundle.files": "Scripts that come with it ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "Not text, so it cannot be shown here.",
  "settings.connectorBundle.findings": "What the checks found",
  "settings.connectorBundle.finding.high": "Blocks installing: {message}",
  "settings.connectorBundle.finding.warn": "Check: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "The first run is in the sandbox. Psyche starts it there to list its tools, and it keeps running there.",
  "settings.connectorBundle.sandbox.container":
    "The first run is in a sandbox container. Psyche starts it there to list its tools, and it keeps running there.",
  "settings.connectorBundle.sandbox.none":
    "This Mac has no sandbox for command connectors, and Psyche never runs one outside it. This connector cannot be installed here. Nothing was started or saved.",
  "settings.connectorBundle.blocker.scan":
    "The checks found something that blocks installing it. Nothing was started or saved.",
  "settings.connectorBundle.blocker.probe_failed":
    "The first run, with no network and no secrets, could not start it. Nothing was saved.",
  "settings.connectorBundle.signer.ownRetired":
    "Signed with a key of yours that you replaced. It is not treated as yours any more.",
  "settings.connectorBundle.signer.retired":
    "Signed by {name}, with a key that was replaced by a rotation you have seen. A new file from it is suspect.",
  "settings.connectorBundle.carry.kept": "Values you gave that stay: {names}",
  "settings.connectorBundle.carry.cleared":
    "Values you gave that are not carried over, because the signer or the command changed. Enter them again: {names}",
  "settings.connectorBundle.carry.vault":
    "Secrets you stored earlier stay in your vault but are not handed to this version.",
  "settings.connectorBundle.reset.title": "If the record of shared connectors is damaged",
  "settings.connectorBundle.reset.hint":
    "Connectors that came from a file stay off while their record cannot be read. This sets the damaged record aside (restoring the last good copy if there is one); those connectors stay off until you remove them or import them again.",
  "settings.connectorBundle.reset.go": "Reset the record…",
  "settings.connectorBundle.reset.confirm": "Yes, reset it",
  "settings.connectorBundle.reset.done":
    "The record was reset. {restored, select, true {The last good copy was restored.} other {It starts empty.}}",
  "settings.connectorBundle.reset.failed": "Could not reset the record: {reason}",
  "settings.connectorBundle.hash": "Bundle id",
  "settings.connectorBundle.close": "Close",
  // --- an update ---
  "settings.connectorBundle.widened.title": "Asks for more than the version you have",
  "settings.connectorBundle.widened.hint":
    "Approving this card gives it these. A card for the narrower version would not have covered them.",
  "settings.connectorBundle.widened.command": "A different command",
  "settings.connectorBundle.widened.commandValue": "Now {now}. Before: {before}",
  "settings.connectorBundle.widened.env": "More variables",
  "settings.connectorBundle.widened.secrets": "More secrets",
  "settings.connectorBundle.widened.network": "More network",
  "settings.connectorBundle.widened.tools": "More tools, or tools that can do more",
  "settings.connectorBundle.widened.payload": "Different scripts",
  "settings.connectorBundle.widened.payloadValue": "The bundled files changed",
  "settings.connectorBundle.diff": "What changed",
  "settings.connectorBundle.noChanges": "Nothing else changed.",
  // --- importing ---
  "settings.connectorBundle.import.title": "Shared connectors",
  "settings.connectorBundle.import.hint":
    "Import a connector someone sent you as a file or a link. You see everything it asks for before anything is installed.",
  "settings.connectorBundle.import.file": "Import a connector file",
  "settings.connectorBundle.import.linkLabel": "Or paste a link to one",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "Review",
  "settings.connectorBundle.import.checking": "Checking…",
  "settings.connectorBundle.import.failed": "Could not import the connector: {reason}",
  "settings.connectorBundle.import.tooBig": "That file is too large to be a connector.",
  "settings.connectorBundle.import.denied": "{name} was not installed.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {The card for {name} expired.} other {The card for {name} no longer applies.}} Import it again to review it.",
  "settings.connectorBundle.import.added":
    "Added {name}. Give it the secrets it needs below, then it can use them.",
  "settings.connectorBundle.import.addedNoSecrets": "Added {name}.",
  "settings.connectorBundle.import.addFailed": "Could not add {name}: {reason}",
  "settings.connectorBundle.import.secretsTitle": "Secrets for {name}",
  // --- sharing ---
  "settings.connectorBundle.share.title": "Share this connector",
  "settings.connectorBundle.share.hint":
    "Makes a signed file with the command, the names of its variables and secrets, the network it reaches and its tools. No value is ever included. You confirm what goes in it first.",
  "settings.connectorBundle.share.go": "Share…",
  "settings.connectorBundle.share.nameLabel": "Your name on shared connectors",
  "settings.connectorBundle.share.nameHint":
    "Everyone who imports a file of yours sees this name. It is asked once; your signing key is made now.",
  "settings.connectorBundle.share.make": "Make the file",
  "settings.connectorBundle.share.label": "Share {name}",
  "settings.connectorBundle.share.done":
    "Saved {file}, signed as {author}. It holds names only: no variable or secret value.",
  "settings.connectorBundle.share.failed": "Could not share the connector: {reason}",
  "settings.connectorBundle.share.unavailable":
    "Only Psyche on the Mac that runs it can sign a connector.",
  // --- author key ---
  "settings.skills.signer.ownRetired":
    "Signed with a key of yours that you replaced. It is not treated as yours any more.",
  "settings.skills.signer.retired":
    "Signed by {name}, with a key that was replaced by a rotation you have seen. A new file from it is suspect.",
  "settings.skills.signer.rotated":
    "Signed by {name}: same author, new key (signed by the old key). The new key is not trusted until you trust it.",
  "settings.skills.author.state.seen": "Seen, not trusted",
  "settings.skills.author.state.trusted": "Trusted",
  "settings.skills.author.state.revoked": "Revoked",
  "settings.skills.keys.title": "Your author key and notices",
  "settings.skills.keys.hint":
    "The key that signs the skills and connectors you share. You can replace it, and publish a notice when a key or a file should no longer be trusted.",
  "settings.skills.keys.none":
    "You have not signed anything yet. Your key is made the first time you share a skill or a connector.",
  "settings.skills.keys.own": "Signing as {name}",
  "settings.skills.keys.fingerprint": "Key",
  "settings.skills.keys.rotate": "Replace my key…",
  "settings.skills.keys.rotateHint":
    "Makes a new key under the same name. The old key signs a statement naming the new one, so people who trusted you see the same author with a new key. They still have to trust it themselves. You confirm first.",
  "settings.skills.keys.rotateLabel": "Replace your author key",
  "settings.skills.keys.rotated": "Your key was replaced. The new key is {key}.",
  "settings.skills.keys.rotateFailed": "Could not replace the key: {reason}",
  "settings.skills.keys.notice.title": "Publish a notice",
  "settings.skills.keys.notice.hint":
    "A notice is a small signed file. Send it or host it, and anyone who has met your key can import it to block a key or one file.",
  "settings.skills.keys.notice.kindKey": "My key (the current one)",
  "settings.skills.keys.notice.kindBundle": "One file I shared, by its bundle id",
  "settings.skills.keys.notice.kind": "What is bad",
  "settings.skills.keys.notice.hash": "Bundle id (sha256:…)",
  "settings.skills.keys.notice.reason": "Why (everyone who imports it sees this)",
  "settings.skills.keys.notice.make": "Make the notice",
  "settings.skills.keys.notice.label": "Sign a revocation notice",
  "settings.skills.keys.notice.done": "Saved {file}. Publish it however you like.",
  "settings.skills.keys.notice.failed": "Could not make the notice: {reason}",
  "settings.skills.keys.import.title": "Import a revocation notice",
  "settings.skills.keys.import.hint":
    "Applied only when it is signed by an author you have met. It can only block: it never trusts anything.",
  "settings.skills.keys.import.file": "Import a notice file",
  "settings.skills.keys.import.linkLabel": "Or paste a link",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "Import",
  "settings.skills.keys.import.key": "Blocked the key {key}. Reason given: {reason}",
  "settings.skills.keys.import.bundle": "Blocked the file {hash}. Reason given: {reason}",
  "settings.skills.keys.import.previewKey":
    "This will revoke the key {key}{names, select, none {} other { (known as {names})}}. Reason given by the signer: {reason}",
  "settings.skills.keys.import.previewBundle":
    "This will block the file {hash}. Reason given by the signer: {reason}",
  "settings.skills.keys.import.already": "It is already in effect.",
  "settings.skills.keys.import.apply": "Apply it",
  "settings.skills.keys.import.signedBy": "Signed by {name}.",
  "settings.skills.keys.import.failed": "Could not use the notice: {reason}",
} as const;
