# Spike 07: Shortcuts automation triggers and Voice Memos storage on macOS 27

- **Status:** done, 2026-10-25 (desk research, under an hour)
- **Machine:** MacBook Pro (Apple M5), macOS 27.0.1 (26A434)
- **Informs:** docs/workflows/mail-and-meetings-2026.md §4.6 (post-meeting inputs), §4.7 (triggers) and §8.4; workstream H (#673) and W (#670)
- **Method:** I read only system files: the WorkflowKit localization table, class names in the dyld shared cache, and the Voice Memos app's code signature. I did not open the Shortcuts or Voice Memos apps, read their data or stat their containers, so no TCC prompt appeared and the owner's data was not touched. The points that need the UI to confirm are listed under "Still to confirm".

## 1. Which Shortcuts personal-automation triggers exist on the Mac for mail and files

**Answer:** macOS 27 ships the trigger classes for mail, messages, files and folders. The list in the Shortcuts app should confirm whether the email trigger is offered on the Mac; the file and folder triggers are Mac-only, so they certainly are.

The macOS 27 shared cache contains these `WF…Trigger` classes. Three groups matter here:
- **Mail and messages:** `WFEmailTrigger`, `WFMessageTrigger`.
- **Files:** `WFFileTrigger`, `WFFolderTrigger`, `WFFilesystemTrigger`, `WFDiskMountTrigger`, `WFScreenshotTrigger`.
- **Mac-only (they show the Mac code is in this build):** `WFStageManagerTrigger`, `WFExternalDisplayTrigger`, `WFKeyboardTrigger`.

There are also the usual ones (time of day, alarm, app, Wi-Fi, Bluetooth, battery, Focus, sound recognition and others). `WFTriggerRegistryAvailableTrigger` suggests a registry decides per platform which triggers to list.

WorkflowKit's strings give the user-facing shape of each:

| Trigger | Wording | Parameters it implies |
| --- | --- | --- |
| Email | "When I receive an email where …", "When I Get an Email %@" | sender, subject, account (the iOS trigger's filters) |
| Message | "When I receive a message where …" | sender, contains text |
| Folder | "When items are added to: %@", "… modified in", "… removed from", "When items change in" | one folder and the kind of change |
| File | "When file is modified", "When %@ is modified" | one file |
| External drive | "When any external drive connects / disconnects" | — |

Two folder-trigger limits appear in the strings: "Automation was disabled because the folder exceeds maximum allowed size" and "… because the folder was moved to trash". A watch on a large Recordings folder can therefore switch itself off.

**What this means for the spec:**
- **Recordings (`recording.added`, §4.7 table, "Later").** A folder trigger "When items are added to: Recordings" that runs a Psyche Action is viable on macOS 26+, but it is opt-in and goes stale if the folder grows too large. The wave 1 poll of a granted folder stays the default, and the Shortcuts route is an extra.
- **Mail (`mail.received`).** `WFEmailTrigger` is in the Mac build. If the Shortcuts UI offers it, it gives near-push for Apple Mail without the Mail-rule bridge. If not, the M11 rule bridge stays the wave 2 plan. In both cases the new-mail poll stays the wave 1 default, as the spec says.
- The bridge must not depend on either trigger. Both are owner-created automations that Psyche cannot create or inspect from the helper. There is no public API to create one, and `shortcuts` CLI has no automation verbs.

**Still to confirm (manual, a test account):**
1. Go to Shortcuts → Automation → New, and check that "Email", "Folder" and "File" are listed.
2. Check whether "Run Immediately" (no confirmation) is allowed for the Email trigger on the Mac. On iOS 17+ it is.
3. Check whether the Email trigger fires for every account or only for iCloud / Mail accounts.

## 2. Where Voice Memos keeps recordings and transcripts on macOS 27, and the TCC that needs

**Answer:**
- **Location.** Recordings live in the app group container `group.com.apple.VoiceMemos.shared`, which is `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/` (layout on macOS 14+: `Recordings/*.m4a` plus `CloudRecordings.db`).
- **Transcripts.** Each transcript is written inside its `.m4a` as a `tsrp` atom with the metadata key `com.apple.VoiceMemos.tsrp`. There is no separate transcript file.
- **TCC.** The group is a restricted application group, so reading it from Psyche Helper needs Full Disk Access.

Evidence:
- **Group membership.** The Voice Memos signature lists `group.com.apple.VoiceMemos.shared` both in `com.apple.security.application-groups` and in `com.apple.private.security.restricted-application-groups`, and the app is sandboxed (`com.apple.security.app-sandbox`).
- **What a restricted group means.** Another app cannot open the container, not even through the macOS 14 "access data from other apps" (App Data) consent. Only a process with Full Disk Access can read it, and Voice Memos itself only through the restricted-group entitlement.
- **The transcript atom.** The shared cache next to `+[RCMutableMovie movieWithURL:error:]` holds the strings `com.apple.iTunes.voice-memo-skps`, `tsrp` and `com.apple.VoiceMemos.tsrp`. The transcript is a movie metadata item that Voice Memos writes into the recording (`RCMutableMovie`), next to the existing `skps` waveform item. The app binary also has `RCRecordingTranscriptionService`, `FileTranscriptionTask` and `RCLiveTranscription`, which fits transcripts being made on the device and stored with the recording.
- **The atom's contents.** From earlier public descriptions, it is JSON with an `attributedString` of text runs and timing. I did not open a recording to confirm this on 27.

**What this means for the spec:**
- **Wave 1 ("a file the owner drops into chat or the Library"):** needs no TCC beyond what the drop already grants. The helper then transcribes the file with `speech.transcribe_file`. Reading the `tsrp` atom first would skip transcription for memos Voice Memos already transcribed. That is a small AVFoundation metadata read (`AVAsset.metadata` items with the key `com.apple.VoiceMemos.tsrp`), and it can come later.
- **Wave 2 ("Find Voice Memos" Psyche Action):** an App Intent that runs inside Psyche cannot list the container without Full Disk Access. The realistic routes:
  - The owner shares or exports the memo to Psyche (share sheet, drag and drop), which needs no TCC.
  - Full Disk Access for Psyche Helper, the grant Messages already uses. It is broad, so it stays opt-in and its card explains what else it opens.
  - The Voice Memos App Shortcuts, if macOS 27 exposes any for listing recordings. None turned up in these strings; to be confirmed in the Shortcuts action list.
- Never watch the container by default. A folder trigger on it would also need Full Disk Access.

**Still to confirm (manual, a test account with a test memo):**
1. With Full Disk Access granted to a dev build of the helper, check that `Recordings/` and the `.m4a` files are where they are expected (not on the owner's account).
2. Dump the `com.apple.VoiceMemos.tsrp` metadata item of a test memo, and record its JSON shape and time units.
3. Check whether macOS 27 Shortcuts has a Voice Memos "Find Recordings" action.
