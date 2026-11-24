import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheBlocks
import PsycheStore
import Testing

@testable import PsycheClient
@testable import PsycheFeatures

/// "Why do you believe this?" on a fact: the decode of memory.explain, the call it makes, and the sheet's model over
/// a fake Gateway. Nothing here touches the keychain or a prompt.
@MainActor
struct FactExplainTests {
    /// The Gateway's answer (memory.explain): the claim and the chunks it rests on, each with a passage text the
    /// phone must not keep.
    nonisolated static let explained: JSONValue = .object([
        "claim": .object([
            "id": "clm_landlord", "text": "Your landlord. Rent is $1,850, due on the 6th.", "kind": "fact",
            "provenance": "owner", "confidence": .number(0.92), "sources": .array([.string("chk_lease1")]),
        ]),
        "chunks": .array([
            .object([
                "id": "chk_lease1", "source": "memory/lease-2026.md", "lineStart": .number(4), "lineEnd": .number(4),
                "text": "PASSAGE BODY THAT STAYS ON THE GATEWAY", "provenance": "owner", "claimId": "clm_landlord",
                "tokenCount": .number(12), "createdAt": "2026-01-04T10:00:00.000Z", "updatedAt": "2026-01-04T10:00:00.000Z",
            ]),
            .object([
                "id": "chk_escape", "source": "../secrets.md", "lineStart": .number(1), "lineEnd": .number(1), "text": "x",
                "provenance": "owner", "claimId": .null, "tokenCount": .number(1),
                "createdAt": "2026-01-04T10:00:00.000Z", "updatedAt": "2026-01-04T10:00:00.000Z",
            ]),
        ]),
    ])

    /// A live backend whose Gateway answers `memory.explain` with `answer`.
    nonisolated func explain(_ answer: Result<JSONValue, WireError>) async throws -> (GatewayBackend, FakeGateway) {
        let (backend, h) = try await MemorySearchWidgetsTests().live { g in
            g.on("memory.explain") { _ in answer }
        }
        return (backend, h.gateway)
    }

    @Test func decodeKeepsTheSentenceConfidenceAndOneChipPerChunkWithoutItsText() throws {
        let result = try GatewayBackend.explanation(Self.explained)
        #expect(result.text == "Your landlord. Rent is $1,850, due on the 6th.")
        #expect(result.confidence == 0.92)
        #expect(result.sources.map(\.title) == ["memory/lease-2026.md", "../secrets.md"])
        #expect(result.sources.first?.source == "memory")
        #expect(result.sources.first?.span == "")
        #expect(result.sources.first?.date == "Jan 4")
    }

    @Test func aPlainWorkspacePathOpensItsFileAndAnyOtherPathOpensNothing() throws {
        let result = try GatewayBackend.explanation(Self.explained)
        #expect(result.sources[0].route == "/agent/soul?file=memory/lease-2026.md")
        #expect(result.sources[1].route == nil)
        #expect(SourceChipRow.open(result.sources[1], with: { _ in true }) == false)
    }

    @Test func aClaimWithoutAnyChunkHasNoSources() throws {
        let bare: JSONValue = .object([
            "claim": .object(["id": "clm_bank", "text": "Prefers a bank transfer.", "confidence": .number(0.6)]),
            "chunks": .array([]),
        ])
        let result = try GatewayBackend.explanation(bare)
        #expect(result.sources.isEmpty)
        #expect(result.confidence == 0.6)
    }

    @Test func aMalformedAnswerWithoutAClaimTextIsNotFound() {
        #expect(throws: BackendError.notFound) {
            try GatewayBackend.explanation(.object(["chunks": .array([])]))
        }
    }

    @Test func theBackendSendsTheClaimIdAndDecodesTheExplanation() async throws {
        let (backend, gateway) = try await explain(.success(Self.explained))
        let result = try await backend.explainFact(claimID: "clm_landlord")
        #expect(result.sources.count == 2)
        let sent = gateway.received.first { $0.method == "memory.explain" }
        #expect(sent?.params?["claimId"]?.string == "clm_landlord")
    }

    @Test func theSheetModelShowsTheGatewaysRefusalInItsOwnWords() async throws {
        let (backend, _) = try await explain(.failure(WireError(code: "not_found", message: "no such claim")))
        let model = FactExplainModel(claimID: "clm_gone", store: backend)
        await model.load()
        guard case .failed(let message) = model.phase else {
            Issue.record("expected a failed phase, got \(model.phase)")
            return
        }
        #expect(message == BackendError.notFound.errorDescription)
    }

    @Test func theSheetModelLoadsTheExplanationOfItsClaim() async throws {
        let (backend, _) = try await explain(.success(Self.explained))
        let model = FactExplainModel(claimID: "clm_landlord", store: backend)
        await model.load()
        #expect(model.phase.value?.sources.count == 2)
    }
}
