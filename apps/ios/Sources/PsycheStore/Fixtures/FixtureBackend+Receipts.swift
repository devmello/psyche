import Foundation

/// Receipts and artifacts' fixture state: four receipts, and two artifacts (an HTML page with two versions and a
/// Markdown note with one).
struct ReceiptsState: Sendable {
    var receipts = FixtureReceipts.all
    var artifacts = FixtureReceipts.artifacts
    /// Every version of each artifact, oldest first, with its content.
    var versions = FixtureReceipts.versions
}

/// The fixture rows, shared by the state above and by tests.
enum FixtureReceipts {
    static let all: [ReceiptItem] = [
        ReceiptItem(
            id: "rcpt_4c1", kind: "payment", summary: "Paid the Lindqvist invoice from the household card",
            outcome: .ok, when: "Mon 10:14", taskID: "task_invoice", merchant: "Lindqvist Studio", amount: "€240.00",
            references: [ReceiptReference(key: "invoice", value: "INV-2041")]),
        ReceiptItem(
            id: "rcpt_9b7", kind: "email.send", summary: "Sent the Q3 review to Priya",
            outcome: .ok, when: "Sun 18:02", taskID: "task_q3", references: [ReceiptReference(key: "to", value: "priya@example.com")]),
        ReceiptItem(
            id: "rcpt_3f0", kind: "calendar.create", summary: "Booked the dentist for Thursday",
            outcome: .uncertain, when: "Fri 09:30", references: [ReceiptReference(key: "calendar", value: "Personal")]),
        ReceiptItem(
            id: "rcpt_72a", kind: "payment", summary: "Renewal card payment was declined",
            outcome: .failed, when: "Wed 07:55", taskID: "task_renew", merchant: "Fieldnote", amount: "$12.00"),
    ]

    static let artifacts: [ArtifactItem] = [
        ArtifactItem(id: "art_q3", title: "Q3 review", type: "html", version: 2, updatedAt: "Mon 10:20"),
        ArtifactItem(id: "art_plan", title: "Trip plan", type: "markdown", version: 1, updatedAt: "Sat 16:45"),
    ]

    static let versions: [String: [(ArtifactVersionItem, String)]] = [
        "art_q3": [
            (ArtifactVersionItem(version: 1, author: "agent", summary: "First draft", createdAt: "Mon 10:12"),
             "<!doctype html><html><body><h1>Q3 review</h1><p>Draft one.</p></body></html>"),
            (ArtifactVersionItem(version: 2, author: "user", summary: "Added the revenue table", createdAt: "Mon 10:20"),
             "<!doctype html><html><body><h1>Q3 review</h1><p>Revenue up 12 percent.</p><table><tr><td>July</td><td>4.1</td></tr></table></body></html>"),
        ],
        "art_plan": [
            (ArtifactVersionItem(version: 1, author: "agent", summary: "Created", createdAt: "Sat 16:45"),
             "# Trip plan\n\n- Book the train\n- Pack the charger\n"),
        ],
    ]
}

extension FixtureBackend: ReceiptsBackend {
    public func receipts(cursor: String?) async throws -> ReceiptPage {
        await pause()
        // The fixture has few rows, so it fits one page; the cursor is only echoed back.
        return ReceiptPage(receipts: receiptsState.receipts, nextCursor: nil)
    }

    public func receipt(id: String) async throws -> ReceiptItem {
        await pause()
        guard let item = receiptsState.receipts.first(where: { $0.id == id }) else { throw BackendError.notFound }
        return item
    }

    public func artifacts(cursor: String?) async throws -> ArtifactPage {
        await pause()
        return ArtifactPage(artifacts: receiptsState.artifacts, nextCursor: nil)
    }

    public func artifactContent(id: String, version: Int?) async throws -> ArtifactContent {
        await pause()
        guard let item = receiptsState.artifacts.first(where: { $0.id == id }),
            let rows = receiptsState.versions[id]
        else { throw BackendError.notFound }
        let wanted = version ?? item.version
        guard let row = rows.first(where: { $0.0.version == wanted }) else { throw BackendError.notFound }
        return ArtifactContent(
            artifactID: id, version: wanted, type: item.type, content: row.1,
            totalLines: row.1.split(separator: "\n", omittingEmptySubsequences: false).count)
    }

    public func artifactVersions(id: String) async throws -> [ArtifactVersionItem] {
        await pause()
        guard let rows = receiptsState.versions[id] else { throw BackendError.notFound }
        return rows.map(\.0)
    }

    public func restoreArtifact(id: String, version: Int) async throws -> Int {
        await pause()
        guard let index = receiptsState.artifacts.firstIndex(where: { $0.id == id }),
            let rows = receiptsState.versions[id],
            let source = rows.first(where: { $0.0.version == version })
        else { throw BackendError.notFound }
        let next = (rows.last?.0.version ?? 0) + 1
        let meta = ArtifactVersionItem(
            version: next, author: "user", summary: "Restored version \(version)", createdAt: "Just now", restoredFrom: version)
        receiptsState.versions[id] = rows + [(meta, source.1)]
        receiptsState.artifacts[index].version = next
        receiptsState.artifacts[index].updatedAt = "Just now"
        publish(.changed(.library))
        return next
    }
}
