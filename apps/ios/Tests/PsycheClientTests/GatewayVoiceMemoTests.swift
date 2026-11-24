import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// Wire shapes of the voice memo methods, checked against `packages/protocol/src/methods/voice.ts`.
struct GatewayVoiceMemoTests {
    @Test func startAsksForAMemoSessionInTheEngineFormat() {
        let params = GatewayBackend.voiceStartParams()
        #expect(params["memo"]?.bool == true)
        #expect(params["format"]?["encoding"]?.string == "pcm_s16le")
        #expect(params["format"]?["sampleRate"]?.int == 16_000)
        #expect(params["format"]?["channels"]?.int == 1)
        #expect(params["threadId"] == nil)
    }

    @Test func pushSendsTheChunkBase64WithItsSequenceNumber() {
        let params = GatewayBackend.voicePushParams(sessionID: "s-1", seq: 3, pcm: Data([0x01, 0x02]))
        #expect(params["sessionId"]?.string == "s-1")
        #expect(params["seq"]?.int == 3)
        #expect(params["audio"]?.string == "AQI=")
    }

    @Test func saveNamesOnlyTheSessionSoTheProtocolDefaultsApply() {
        let params = GatewayBackend.voiceMemoSaveParams(sessionID: "s-1")
        #expect(params["sessionId"]?.string == "s-1")
        #expect(params["task"] == nil)
        #expect(params["threadId"] == nil)
    }

    @Test func saveResultDecodesTheFiledItemTranscriptAndLength() throws {
        let json = """
            {
              "transcript": {"text": "Remind me to call the dentist.", "segments": []},
              "item": {"id": "lib-9", "name": "Voice memo.wav", "kind": "document", "size": 2048,
                       "createdAt": "2026-11-24T09:00:00.000Z"},
              "task": null,
              "provenance": {},
              "content": {"urls": [], "instructionLike": false, "flags": []},
              "blocks": [],
              "durationMs": 4200
            }
            """
        let result = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let saved = try GatewayBackend.voiceMemoSaved(from: result)
        #expect(saved.item.id == "lib-9")
        #expect(saved.transcript == "Remind me to call the dentist.")
        #expect(saved.durationMs == 4200)
    }

    @Test func saveResultWithoutAnItemIsRefused() throws {
        let result = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"transcript": {"text": "x", "segments": []}}"#.utf8))
        #expect(throws: BackendError.self) {
            try GatewayBackend.voiceMemoSaved(from: result)
        }
    }
}
