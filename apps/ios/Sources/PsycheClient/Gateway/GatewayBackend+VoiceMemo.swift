import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Voice memos over `voice.start` (memo: true), `voice.push`, `voice.memo.save` and `voice.cancel`. The Mac runs
// the engine and files the memo; the phone sends 16 kHz mono s16le PCM in order. A phone-started session is
// `caller: desktop` on the Gateway, so the Mac's engine policy applies (no Web Speech).
extension GatewayBackend {
    /// The audio the phone sends: what `voice.push` takes (`pcm_s16le`, 16 kHz, mono).
    static let voiceMemoSampleRate = 16_000

    static func voiceStartParams() -> JSONValue {
        .obj([
            "format": .obj([
                "encoding": .string("pcm_s16le"),
                "sampleRate": .number(Double(voiceMemoSampleRate)),
                "channels": .number(1),
            ]),
            "memo": .bool(true),
        ])
    }

    static func voicePushParams(sessionID: String, seq: Int, pcm: Data) -> JSONValue {
        .obj([
            "sessionId": .string(sessionID),
            "seq": .number(Double(seq)),
            "audio": .string(pcm.base64EncodedString()),
        ])
    }

    /// No `task` key: the protocol default applies (`voice.memo.save` decides on its own whether to make a Task).
    static func voiceMemoSaveParams(sessionID: String) -> JSONValue {
        .obj(["sessionId": .string(sessionID)])
    }

    static func voiceSessionParams(sessionID: String) -> JSONValue {
        .obj(["sessionId": .string(sessionID)])
    }

    /// `voice.memo.save`'s answer: the filed Library item, the transcript text and the length.
    static func voiceMemoSaved(from result: JSONValue) throws -> VoiceMemoSaved {
        guard let item = result["item"].flatMap({ libraryItem(from: $0) }) else {
            throw BackendError.refused("The Gateway didn't store that file.")
        }
        return VoiceMemoSaved(
            item: item,
            transcript: result["transcript"]?["text"]?.string ?? "",
            durationMs: result["durationMs"]?.int ?? 0)
    }

    public func startVoiceMemo() async throws -> String {
        let result = try await call("voice.start", Self.voiceStartParams(), key: "voice-start-\(UUID().uuidString)")
        // `null` with location "client" means the browser dictates; a phone never gets that, so the Mac is out of reach.
        guard let id = result["sessionId"]?.string, !id.isEmpty else { throw BackendError.unreachable }
        return id
    }

    public func pushVoiceMemo(sessionID: String, seq: Int, pcm: Data) async throws {
        _ = try await call("voice.push", Self.voicePushParams(sessionID: sessionID, seq: seq, pcm: pcm))
    }

    public func saveVoiceMemo(sessionID: String) async throws -> VoiceMemoSaved {
        let result = try await call(
            "voice.memo.save", Self.voiceMemoSaveParams(sessionID: sessionID), key: "voice-memo-save-\(sessionID)")
        let saved = try Self.voiceMemoSaved(from: result)
        await client.publishLive(.changed(.library))
        return saved
    }

    public func cancelVoiceMemo(sessionID: String) async throws {
        _ = try await call("voice.cancel", Self.voiceSessionParams(sessionID: sessionID))
    }
}
