import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Night shift over `nightShift.*` (docs/design/night-shift-2026.md §3.3, §5.2). Applying is two steps and the second one
// is the owner's tap: `nightShift.apply` mints one `staged_apply` approval for the ticked calls, then this phone answers
// it with the token it was handed. Between the two, the approval's own list of calls (`details.items[]`) is compared with
// what the owner ticked and saw. Any difference refuses the answer: the tap approves exactly what was shown.
extension GatewayBackend {
    /// Suffix of the approval row for a draft's send (`<itemId>:send`).
    static let nightShiftSendSuffix = ":send"

    public func nightShiftStatus() async throws -> NightShiftStatus {
        let result = try await call("nightShift.status", .obj([:]))
        return Self.nightShiftStatus(result)
    }

    public func nightShiftReview(id: String) async throws -> NightShiftReview {
        let result = try await call("nightShift.review.get", .obj(["reviewId": .string(id)]))
        guard let night = result["night"], let nightID = night["id"]?.string else { throw BackendError.notFound }
        let items = (result["items"]?.array ?? []).compactMap { Self.nightShiftItem($0) }
        return NightShiftReview(
            id: nightID, night: night["night"]?.string ?? "", expiresAt: WireFormat.date(night["expiresAt"]?.string),
            items: items)
    }

    public func applyNightShift(_ request: NightShiftApplyRequest) async throws -> NightShiftApplyOutcome {
        guard !request.items.isEmpty else {
            throw BackendError.refused(String(localized: "Tick something to apply first.", bundle: .module))
        }
        let result = try await call("nightShift.apply", Self.nightShiftApplyParams(request))
        return try await answerStagedApproval(result) { approval, refused in
            Self.approvalBindsExactly(approval, request: request, refused: refused)
        }
    }

    public func undoNightShift(itemIDs: [String]) async throws -> NightShiftApplyOutcome {
        guard !itemIDs.isEmpty else {
            throw BackendError.refused(String(localized: "Tick something to apply first.", bundle: .module))
        }
        let result = try await call("nightShift.undo", .obj(["itemIds": .array(itemIDs.map(JSONValue.string))]))
        return try await answerStagedApproval(result) { approval, refused in
            Self.undoApprovalBindsExactly(approval, itemIDs: itemIDs, refused: refused)
        }
    }

    public func dismissNightShift(reviewID: String, itemIDs: [String]?) async throws {
        _ = try await call("nightShift.dismiss", .obj([
            "reviewId": .string(reviewID), "itemIds": itemIDs.map { .array($0.map(JSONValue.string)) },
        ]))
    }

    /// The part apply and undo share: read the Gateway's refusals, check the approval binds what was asked (before
    /// anything is answered), hand a payment or too-large card to the Mac, and otherwise answer with this phone's token.
    private func answerStagedApproval(
        _ result: JSONValue, binds: (JSONValue, Set<String>) -> Bool
    ) async throws -> NightShiftApplyOutcome {
        let refused = Self.nightShiftRefusals(result["refused"])
        guard let approval = result["approval"], let approvalID = approval["id"]?.string else {
            return .nothingApproved(refused: refused)
        }
        // The check that stands between the owner's tap and the Gateway: refuse before anything is answered.
        guard binds(approval, Set(refused.map(\.itemID))) else { throw NightShiftApplyError.mismatch }
        // A payment, or details too large to show in full here, is never answered from the phone.
        if approval["requiresAuthentication"]?.bool == true || Self.detailsNeedMac(approval["details"]) {
            return .needsMac(refused: refused)
        }
        guard approval["status"]?.string == "pending" || approval["status"] == nil,
              let token = result["answerToken"]?.string
        else { return .needsMac(refused: refused) }
        _ = try await call("approvals.answer", Self.suggestionAnswerParams(approvalID: approvalID, token: token))
        return .answered(refused: refused)
    }

    // MARK: - The binding check (static, so tests pin it)

    /// A recipient list as a comparable set: trimmed, lowercased, sorted.
    private static func recipientSet(_ list: [String]) -> [String] {
        list.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.sorted()
    }

    /// The approval's rows split into drafts (`itemId` to `bindingHash`) and sends (`<itemId>:send` to its `send.to`).
    /// Nil when anything is malformed: an entry without an id or hash, a repeated id, a row marked withheld (this phone
    /// ticked what it saw in full), or a send row without its recipients.
    private static func approvalRows(_ approval: JSONValue) -> (drafts: [String: String], sends: [String: [String]])? {
        guard approval["kind"]?.string == "staged_apply", let entries = approval["details"]?["items"]?.array else { return nil }
        var drafts: [String: String] = [:]
        var sends: [String: [String]] = [:]
        for entry in entries {
            guard let id = entry["itemId"]?.string, !id.isEmpty, let hash = entry["bindingHash"]?.string, !hash.isEmpty,
                  entry["withheld"] == nil
            else { return nil }
            if id.hasSuffix(nightShiftSendSuffix) {
                let draft = String(id.dropLast(nightShiftSendSuffix.count))
                guard sends[draft] == nil, let to = entry["send"]?["to"]?.array, to.allSatisfy({ $0.string != nil }) else { return nil }
                sends[draft] = to.compactMap(\.string)
            } else {
                guard drafts[id] == nil else { return nil }
                drafts[id] = hash
            }
        }
        return (drafts, sends)
    }

    /// True when the approval is a `staged_apply` that binds exactly what the owner ticked:
    ///  - the draft rows `{itemId, bindingHash}` are the ticked items, each with the hash the owner saw. An item the
    ///    Gateway refused may be absent (and only then);
    ///  - the `<itemId>:send` rows are the ticked sends, each repeating the recipients the owner saw (`send.to`). A
    ///    send the Gateway refused is absent.
    /// An extra row, a missing one, a changed hash, a repeated id, a `withheld` row or a changed recipient fails.
    static func approvalBindsExactly(_ approval: JSONValue, request: NightShiftApplyRequest, refused: Set<String>) -> Bool {
        guard let rows = approvalRows(approval) else { return false }
        var ticked: [String: String] = [:]
        for tick in request.items {
            guard ticked[tick.itemID] == nil else { return false }
            ticked[tick.itemID] = tick.hash
        }
        for (id, hash) in rows.drafts where ticked[id] != hash { return false }
        for id in ticked.keys where rows.drafts[id] == nil && !refused.contains(id) { return false }
        var tickedSends: [String: [String]] = [:]
        for tick in request.sends {
            guard tickedSends[tick.itemID] == nil else { return false }
            tickedSends[tick.itemID] = tick.recipients
        }
        for (id, to) in rows.sends {
            // A send needs its draft in the same approval, and must be one the owner ticked, to the same people.
            guard rows.drafts[id] != nil, let seen = tickedSends[id], Self.recipientSet(seen) == Self.recipientSet(to) else {
                return false
            }
        }
        for id in tickedSends.keys where rows.sends[id] == nil && !refused.contains(id) { return false }
        return true
    }

    /// An undo's approval lists exactly the items asked for (the inverse calls carry hashes only the Gateway can
    /// compute). No send rows, no withheld rows.
    static func undoApprovalBindsExactly(_ approval: JSONValue, itemIDs: [String], refused: Set<String>) -> Bool {
        guard let rows = approvalRows(approval), rows.sends.isEmpty else { return false }
        let asked = Set(itemIDs)
        guard asked.count == itemIDs.count, Set(rows.drafts.keys).isSubset(of: asked) else { return false }
        return asked.allSatisfy { rows.drafts[$0] != nil || refused.contains($0) }
    }

    static func nightShiftApplyParams(_ request: NightShiftApplyRequest) -> JSONValue {
        .obj([
            "reviewId": .string(request.reviewID),
            "items": .array(request.items.map { .obj(["itemId": .string($0.itemID), "bindingHash": .string($0.hash)]) }),
            "sends": .array(request.sends.map { .obj(["itemId": .string($0.itemID), "sendHash": .string($0.hash)]) }),
        ])
    }

    /// The generic line for an item made from the owner's Messages, in the app's language.
    static var withheldMessagesLine: String {
        String(localized: "An item from your Messages. Open on your Mac to apply.", bundle: .module)
    }

    /// An approval's details with each withheld row's summary replaced by the localized generic line, so the card the phone
    /// shows (the approval sheet) names nothing and reads in the app's language.
    static func localizingWithheld(_ details: JSONValue?) -> JSONValue? {
        guard case .object(var object)? = details, case .array(let items)? = object["items"] else { return details }
        object["items"] = .array(items.map { entry in
            guard case .object(var row) = entry, row["withheld"]?.string == "messages" else { return entry }
            row["summary"] = .string(withheldMessagesLine)
            return .object(row)
        })
        return .object(object)
    }

    // MARK: - Mapping

    static func nightShiftStatus(_ result: JSONValue) -> NightShiftStatus {
        let counts = result.at("latest", "counts")
        return NightShiftStatus(
            enabled: result["enabled"]?.bool == true,
            counts: NightShiftCounts(
                mail: max(0, counts?["mail"]?.int ?? 0), calendar: max(0, counts?["calendar"]?.int ?? 0),
                reminders: max(0, counts?["reminders"]?.int ?? 0), files: max(0, counts?["files"]?.int ?? 0)),
            readyReviewID: result["readyReviewId"]?.string,
            expiresAt: WireFormat.date(result.at("latest", "expiresAt")?.string))
    }

    static func nightShiftRefusals(_ value: JSONValue?) -> [NightShiftRefusal] {
        (value?.array ?? []).compactMap { entry in
            guard let id = entry["itemId"]?.string else { return nil }
            return NightShiftRefusal(itemID: id, reason: DisplaySafe.text(entry["reason"]?.string ?? ""))
        }
    }

    /// One prepared item. Only the Gateway's own fields are read, and every string is made safe for plain display. An
    /// unknown domain is dropped (nothing to draw); an unknown status reads as stale, which can't be ticked.
    static func nightShiftItem(_ item: JSONValue, now: Date = .now) -> NightShiftItem? {
        guard let id = item["id"]?.string, let hash = item["bindingHash"]?.string, !hash.isEmpty,
              let domain = item["domain"]?.string.flatMap(NightShiftDomain.init(rawValue:))
        else { return nil }
        let status = item["status"]?.string.flatMap(NightShiftItemStatus.init(rawValue:)) ?? .stale
        let withheld = item["withheld"]?.string == "messages"
        let preview = item["preview"]
        // The whole draft is the frozen `body` argument. Past the phone's drawing limit it stays on the Mac.
        let fullText = item.at("params", "body")?.string
        let oversize = (fullText?.count ?? 0) > Self.nestedLimit || Self.detailsNeedMac(preview?.object.map { JSONValue.object($0) })
        let rows: [NightShiftRow] = (preview?["rows"]?.array ?? []).compactMap { row in
            guard let label = row["label"]?.string, let value = row["value"]?.string else { return nil }
            return NightShiftRow(
                label: DisplaySafe.text(label), value: DisplaySafe.paragraphs(value), truncated: row["truncated"]?.bool == true,
                badge: row["badge"]?.string.flatMap(NightShiftRow.Badge.init(rawValue:)))
        }
        let send = item["send"].flatMap { send -> NightShiftSend? in
            guard let sendHash = send["contentHash"]?.string, !sendHash.isEmpty else { return nil }
            return NightShiftSend(
                recipients: (send["recipients"]?.array ?? []).compactMap(\.string).map(DisplaySafe.text), contentHash: sendHash)
        }
        let refs = (item.at("result", "refs")?.array ?? []).compactMap(\.string)
        let appliedAt = WireFormat.date(item["appliedAt"]?.string)
        let undoable = status == .applied && !withheld && item.at("inverse") != nil
            && appliedAt.map { now.timeIntervalSince($0) < 24 * 3600 } == true
        return NightShiftItem(
            id: id, domain: domain, status: status, tool: item["tool"]?.string ?? "",
            summary: DisplaySafe.text(item["summary"]?.string ?? ""), why: withheld ? nil : item["why"]?.string.map(DisplaySafe.text),
            bindingHash: hash, untrusted: item["taint"]?.bool == true, withheldMessages: withheld,
            rows: withheld ? [] : rows, truncated: preview?["truncated"]?.bool == true,
            fullBody: (oversize || withheld) ? nil : fullText.map(DisplaySafe.paragraphs), send: withheld ? nil : send,
            needsMac: oversize && !withheld, applying: status == .ready && item.at("approvalId")?.string != nil,
            reason: item.at("result", "error")?.string.map(DisplaySafe.text), sent: refs.contains { $0.hasPrefix("sent:") },
            canUndo: undoable)
    }
}
