import Foundation

/// Voice memo sessions in the demo: ids, bytes received per session, and the memos filed so far.
struct VoiceMemoFixtureState: Sendable {
    var counter = 0
    var received: [String: Int] = [:]
}

extension FixtureBackend: VoiceMemoBackend {
    public func startVoiceMemo() async throws -> String {
        await pause()
        voiceMemoState.counter += 1
        let id = "fixture-memo-\(voiceMemoState.counter)"
        voiceMemoState.received[id] = 0
        return id
    }

    public func pushVoiceMemo(sessionID: String, seq: Int, pcm: Data) async throws {
        guard voiceMemoState.received[sessionID] != nil else { throw BackendError.notFound }
        voiceMemoState.received[sessionID, default: 0] += pcm.count
    }

    /// Files the memo as a Library document with a fixed transcript, the way the Mac would.
    public func saveVoiceMemo(sessionID: String) async throws -> VoiceMemoSaved {
        await pause()
        guard let bytes = voiceMemoState.received.removeValue(forKey: sessionID) else { throw BackendError.notFound }
        let durationMs = bytes / 2 * 1000 / 16_000
        libraryState.counter += 1
        let item = LibraryItem(
            id: "fixture-library-memo-\(libraryState.counter)",
            title: "Voice memo \(libraryState.counter)",
            section: .documents,
            fileType: "wav",
            detail: "Just now \u{00B7} \(durationMs / 1000) s")
        libraryState.items.insert(item, at: 0)
        return VoiceMemoSaved(
            item: item,
            transcript: "Remind me to call the dentist tomorrow morning.",
            durationMs: durationMs)
    }

    public func cancelVoiceMemo(sessionID: String) async throws {
        await pause()
        voiceMemoState.received.removeValue(forKey: sessionID)
    }
}
