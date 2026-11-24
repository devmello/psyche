import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// "Why do you believe this?" reads the graph fact's own provenance (memory.entities.* facts): the decode of that
/// provenance from the fact as the Gateway sends it. No network call; nothing here touches the keychain or a prompt.
struct FactExplainTests {
    /// One graph fact as the Gateway's person page sends it (graph.ts GraphFact), with the fields "why" reads.
    static func graphFact(
        _ id: String, provenance: String = "agent", sources: [String] = ["mail:m1", "contact:c1", "int_9", "chk_4"],
        evidence: JSONValue = "Could you do the transfer rather than a check?", confidence: Double = 0.6,
        firstSeenAt: JSONValue = "2026-10-28T10:00:00.000Z", lastSeenAt: JSONValue = .null
    ) -> JSONValue {
        .object([
            "id": .string(id), "entityId": "ent_pe1", "attribute": "preference", "value": "Prefers a bank transfer.",
            "provenance": .string(provenance), "confidence": .number(confidence), "sources": .array(sources.map { .string($0) }),
            "evidence": evidence, "validFrom": "2026-10-28T10:00:00.000Z", "validTo": .null,
            "recordedAt": "2026-10-28T10:00:00.000Z", "observedAt": "2026-10-28T10:00:00.000Z",
            "supersededBy": .null, "retractedAt": .null, "firstSeenAt": firstSeenAt, "lastSeenAt": lastSeenAt,
            "extractor": "rule", "someFutureField": .bool(true),
        ])
    }

    @Test func eachGatewayProvenanceReadsAsItsOrigin() {
        #expect(GatewayBackend.provenance(of: Self.graphFact("a", provenance: "owner")).origin == .owner)
        #expect(GatewayBackend.provenance(of: Self.graphFact("b", provenance: "untrusted")).origin == .untrusted)
        #expect(GatewayBackend.provenance(of: Self.graphFact("c", provenance: "system")).origin == .system)
        #expect(GatewayBackend.provenance(of: Self.graphFact("d", provenance: "agent")).origin == .agent)
    }

    @Test func confidenceAndTheQuotedSpanComeThroughUnchanged() {
        let p = GatewayBackend.provenance(of: Self.graphFact("e", provenance: "untrusted"))
        #expect(p.confidence == 0.6)
        #expect(p.evidence == "Could you do the transfer rather than a check?")
    }

    @Test func anEmptyQuoteIsNoQuote() {
        let p = GatewayBackend.provenance(of: Self.graphFact("f", evidence: ""))
        #expect(p.evidence == nil)
    }

    @Test func sourcesShowTheirKindOnceAndRawIdsAreLeftOut() {
        let p = GatewayBackend.provenance(of: Self.graphFact("g", sources: ["mail:m1", "mail:m2", "contact:c1", "int_9", "lf_3", "chk_4"]))
        #expect(p.sourceKinds == ["mail", "contacts"])
    }

    @Test func firstAndLastSeenAreDatesWhenTheGatewaySendsThem() {
        let p = GatewayBackend.provenance(of: Self.graphFact("h", lastSeenAt: "2026-11-02T09:00:00.000Z"))
        #expect(p.firstSeen == WireFormat.date("2026-10-28T10:00:00.000Z"))
        #expect(p.lastSeen == WireFormat.date("2026-11-02T09:00:00.000Z"))
        let none = GatewayBackend.provenance(of: Self.graphFact("i", firstSeenAt: .null, lastSeenAt: .null))
        #expect(none.firstSeen == nil)
        #expect(none.lastSeen == nil)
    }

    @Test func everyCurrentFactCarriesItsProvenanceToThePersonPage() {
        let facts = GatewayBackend.facts([Self.graphFact("pe1-x", provenance: "owner")])
        #expect(facts.count == 1)
        #expect(facts.first?.provenance?.origin == .owner)
        #expect(facts.first?.provenance?.sourceKinds == ["mail", "contacts"])
    }

    @Test func aRetractedFactIsNotShownAndSoHasNoProvenanceToExplain() {
        let retracted: JSONValue = .object([
            "id": "x", "value": "Old", "attribute": "city", "retractedAt": "2026-10-01T00:00:00.000Z",
        ])
        #expect(GatewayBackend.facts([retracted]).isEmpty)
    }
}
