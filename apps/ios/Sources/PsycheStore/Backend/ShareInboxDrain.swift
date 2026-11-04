import Foundation
import PsycheShared

/// Turns what the share extension queued into backend calls (docs/design/mobile-companion-2026.md §2.3):
/// each file goes through `LibraryBackend.upload` with the chosen thread, then the note goes through
/// `ChatBackend.send` with the uploads attached. Owner: the Library session (I6).
public enum ShareInboxDrain {
    /// Drains the inbox in order. The draft's `clientID` is the queued item's id, so a retry after a
    /// half-finished attempt can't send the message twice. "New chat" opens a thread first.
    @discardableResult
    public static func run(inbox: ShareInbox, backend: any PsycheBackend) async -> ShareInbox.DrainResult {
        await inbox.drain(countsAsAttempt: countsAsAttempt) { item in
            let threadID: String
            if let chosen = item.destination.threadID {
                threadID = chosen
            } else {
                threadID = try await backend.newThread().id
            }
            var attachments: [String] = []
            for file in item.files {
                let data = try Data(contentsOf: inbox.fileURL(file, in: item), options: .mappedIfSafe)
                let uploaded = try await backend.upload(
                    UploadFile(name: file.name, contentType: file.contentType, data: data, threadID: threadID))
                attachments.append(uploaded.id)
            }
            _ = try await backend.send(
                MessageDraft(clientID: item.id, threadID: threadID, text: item.messageText, attachmentIDs: attachments))
        }
    }

    /// Whether a failed attempt should use one of an item's `maxAttempts`. Away from the Mac (`unreachable`, or
    /// no network at all) is not the item's fault: it waits without losing an attempt, so a week away from home
    /// cannot throw a share out. Anything else (refused, not found, a bad file) counts.
    public static func countsAsAttempt(_ error: any Error) -> Bool {
        if let backend = error as? BackendError, backend == .unreachable { return false }
        if error is URLError { return false }
        return true
    }

    /// Writes the threads the share sheet's picker offers: the main thread first, then the newest.
    public static func writeRecents(inbox: ShareInbox, backend: any PsycheBackend, limit: Int = 8) async {
        guard let threads = try? await backend.threads() else { return }
        inbox.writeRecents(threads.prefix(limit).map { ShareThreadChoice(id: $0.id, title: $0.title) })
    }
}
