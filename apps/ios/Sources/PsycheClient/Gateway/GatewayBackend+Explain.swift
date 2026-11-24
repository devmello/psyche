import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// "Why do you believe this?" over memory.explain: the claim, its confidence and the sources it rests on.
// The Gateway also sends each passage's text; the phone keeps only the source's path, date and route, so the
// passage body is not shown here (the Gateway decides which connections may read it).
extension GatewayBackend {
    public func explainFact(claimID: String) async throws -> FactExplanation {
        let result = try await call("memory.explain", .obj(["claimId": .string(claimID)]))
        return try Self.explanation(result)
    }

    static func explanation(_ result: JSONValue) throws -> FactExplanation {
        guard let text = result["claim"]?["text"]?.string else { throw BackendError.notFound }
        let chunks = result["chunks"]?.array ?? []
        return FactExplanation(
            text: text,
            confidence: result["claim"]?["confidence"]?.double,
            sources: chunks.compactMap(source))
    }

    /// One chunk as a chip. The route opens the workspace file (Soul & Memory's file view) only for a plain relative
    /// path; anything else gets no route, so its chip is disabled.
    static func source(_ chunk: JSONValue) -> SourceRef? {
        guard let id = chunk["id"]?.string, let path = chunk["source"]?.string, !path.isEmpty else { return nil }
        let plain = path.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._/-".contains($0)) }
        let safe = plain && !path.hasPrefix("/") && !path.split(separator: "/").contains("..")
        let when = WireFormat.date(chunk["createdAt"]?.string)
            .map { $0.formatted(.dateTime.month(.abbreviated).day()) } ?? ""
        return SourceRef(
            id: id, title: path, source: path.hasPrefix("memory/") ? "memory" : "file",
            route: safe ? "/agent/soul?file=\(path)" : nil, span: "", date: when)
    }
}
