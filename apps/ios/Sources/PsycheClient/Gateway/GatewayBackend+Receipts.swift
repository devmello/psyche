import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

// Receipts and artifacts over `receipts.list/get` and `artifacts.list/read/versions/restore`. All read-only
// except restore, which the Gateway records as a new latest version (nothing is deleted).
extension GatewayBackend {
    /// Rows per page for both lists. The Gateway clamps to its own maximum.
    static let receiptPageSize = 50

    public func receipts(cursor: String?) async throws -> ReceiptPage {
        var params: [String: JSONValue] = ["limit": .number(Double(Self.receiptPageSize))]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("receipts.list", .object(params))
        let items = (result["receipts"]?.array ?? []).compactMap(Self.receiptItem)
        return ReceiptPage(receipts: items, nextCursor: result["nextCursor"]?.string)
    }

    public func receipt(id: String) async throws -> ReceiptItem {
        let result = try await call("receipts.get", .object(["receiptId": .string(id)]))
        guard let item = result["receipt"].flatMap(Self.receiptItem) else { throw BackendError.notFound }
        return item
    }

    public func artifacts(cursor: String?) async throws -> ArtifactPage {
        var params: [String: JSONValue] = ["limit": .number(Double(Self.receiptPageSize))]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("artifacts.list", .object(params))
        let items = (result["artifacts"]?.array ?? []).compactMap(Self.artifactItem)
        return ArtifactPage(artifacts: items, nextCursor: result["nextCursor"]?.string)
    }

    public func artifact(id: String) async throws -> ArtifactItem {
        let result = try await call("artifacts.get", .object(["artifactId": .string(id)]))
        guard let item = result["artifact"].flatMap(Self.artifactItem) else { throw BackendError.notFound }
        return item
    }

    /// The Library's Artifacts list: every artifact (the first page) as a Library row. Its id is the artifact's
    /// Library item, and `artifactID` sends a tap to the artifact viewer.
    func artifactLibraryRows() async throws -> [LibraryItem] {
        let page = try await artifacts(cursor: nil)
        return page.artifacts.map { artifact in
            LibraryItem(
                id: artifact.libraryItemID ?? artifact.id, title: artifact.title, section: .artifacts,
                fileType: artifact.type, detail: "\(artifact.updatedAt) \u{00B7} v\(artifact.version)",
                artifactID: artifact.id)
        }
    }

    public func artifactContent(id: String, version: Int?) async throws -> ArtifactContent {
        var params: [String: JSONValue] = ["artifactId": .string(id)]
        if let version { params["version"] = .number(Double(version)) }
        let result = try await call("artifacts.read", .object(params))
        guard let artifactID = result["artifactId"]?.string, let version = result["version"]?.int else {
            throw BackendError.notFound
        }
        return ArtifactContent(
            artifactID: artifactID, version: version, type: result["type"]?.string ?? "doc",
            content: result["content"]?.string ?? "", totalLines: result["totalLines"]?.int ?? 0)
    }

    public func artifactVersions(id: String) async throws -> [ArtifactVersionItem] {
        let result = try await call("artifacts.versions", .object(["artifactId": .string(id)]))
        return (result["versions"]?.array ?? []).compactMap { row in
            guard let version = row["version"]?.int else { return nil }
            return ArtifactVersionItem(
                version: version, author: row["author"]?.string ?? "agent",
                summary: row["summary"]?.string ?? "", createdAt: WireFormat.time(row["createdAt"]?.string),
                restoredFrom: row["restoredFrom"]?.int)
        }
    }

    public func restoreArtifact(id: String, version: Int) async throws -> Int {
        let params: JSONValue = .object(["artifactId": .string(id), "version": .number(Double(version))])
        // One key per tap: a retry of the same tap returns the same restore, never a second version.
        let result = try await call("artifacts.restore", params, key: "artifact-restore-\(UUID().uuidString)")
        guard let latest = result["ref"]?["version"]?.int else { throw BackendError.refused("The Gateway didn't restore that version.") }
        await client.publishLive(.changed(.library))
        return latest
    }

    // MARK: - Mapping

    static func receiptItem(from row: JSONValue) -> ReceiptItem? {
        guard let id = row["id"]?.string else { return nil }
        let refs = row["externalRefs"]?.object ?? [:]
        func text(_ key: String) -> String? {
            guard let value = refs[key] else { return nil }
            if let string = value.string, !string.isEmpty { return string }
            if let number = value.double {
                return number.rounded() == number ? String(Int(number)) : String(number)
            }
            return nil
        }
        let known: Set<String> = ["merchant", "amount"]
        let others = refs.keys.filter { !known.contains($0) }.sorted().compactMap { key -> ReceiptReference? in
            text(key).map { ReceiptReference(key: key, value: $0) }
        }
        return ReceiptItem(
            id: id,
            kind: row["kind"]?.string ?? "",
            summary: row["summary"]?.string ?? "",
            outcome: ReceiptOutcome(rawValue: row["outcome"]?.string ?? "") ?? .uncertain,
            when: WireFormat.time(row["createdAt"]?.string),
            taskID: row["taskId"]?.string,
            merchant: text("merchant"),
            amount: text("amount"),
            references: others)
    }

    static func artifactItem(from row: JSONValue) -> ArtifactItem? {
        guard let id = row["id"]?.string else { return nil }
        return ArtifactItem(
            id: id, title: row["title"]?.string ?? "Untitled", type: row["type"]?.string ?? "doc",
            version: row["version"]?.int ?? 1, updatedAt: WireFormat.time(row["updatedAt"]?.string),
            libraryItemID: row["libraryItemId"]?.string)
    }
}
