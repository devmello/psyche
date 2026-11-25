import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Night shift over `nightShift.*` (docs/design/night-shift-2026.md §3.3, §5.2). Applying is two steps and the second one
// is the owner's tap: `nightShift.apply` mints one `staged_apply` approval for the ticked calls, then this phone answers
// it with the token it was handed. Between the two, the approval's own list of calls (`details.items[].bindingHash`) is
// compared with what the owner ticked. Any difference refuses the answer: the tap approves exactly what was shown.
extension GatewayBackend {
    public func nightShiftStatus() async throws -> NightShiftStatus {
        let result = try await call("nightShift.status", .obj([:]))
        return Self.nightShiftStatus(result)
    }

    public func nightShiftReview(id: String) async throws -> NightShiftReview {
        let result = try await call("nightShift.review.get", .obj(["reviewId": .string(id)]))
        guard let night = result["night"], let nightID = night["id"]?.string else { throw BackendError.notFound }
        let items = (result["items"]?.array ?? []).compactMap(Self.nightShiftItem(_:))
        return NightShiftReview(
            id: nightID, night: night["night"]?.string ?? "", expiresAt: WireFormat.date(night["expiresAt"]?.string),
            items: items)
    }

    public func applyNightShift(_ request: NightShiftApplyRequest) async throws -> NightShiftApplyOutcome {
        guard !request.items.isEmpty else {
            throw BackendError.refused(String(localized: "Tick something to apply first.", bundle: .module))
        }
        let result = try await call("nightShift.apply", Self.nightShiftApplyParams(request))
        let refused = Self.nightShiftRefusals(result["refused"])
        guard let approval = result["approval"], let approvalID = approval["id"]?.string else {
            return .nothingApproved(refused: refused)
        }
        // The check that stands between the owner's tap and the Gateway: refuse before anything is answered.
        guard Self.approvalBindsExactly(approval, request: request, refused: Set(refused.map(\.itemID))) else {
            throw NightShiftApplyError.mismatch
        }
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

    public func dismissNightShift(reviewID: String, itemIDs: [String]?) async throws {
        _ = try await call("nightShift.dismiss", .obj([
            "reviewId": .string(reviewID), "itemIds": itemIDs.map { .array($0.map(JSONValue.string)) },
        ]))
    }

    // MARK: - The binding check (static, so tests pin it)

    /// True when the approval is a `staged_apply` whose `details.items[].bindingHash` are exactly the hashes the owner
    /// ticked (items, then sends), minus what the Gateway reported as refused. An extra call, a missing one, a changed
    /// hash, a repeated hash or an entry without a hash all fail.
    static func approvalBindsExactly(_ approval: JSONValue, request: NightShiftApplyRequest, refused: Set<String>) -> Bool {
        guard approval["kind"]?.string == "staged_apply", let entries = approval["details"]?["items"]?.array else { return false }
        var bound: [String] = []
        for entry in entries {
            guard let hash = entry["bindingHash"]?.string, !hash.isEmpty else { return false }
            bound.append(hash)
        }
        let expected = (request.items + request.sends).filter { !refused.contains($0.itemID) }.map(\.hash)
        return bound.sorted() == expected.sorted()
    }

    static func nightShiftApplyParams(_ request: NightShiftApplyRequest) -> JSONValue {
        .obj([
            "reviewId": .string(request.reviewID),
            "items": .array(request.items.map { .obj(["itemId": .string($0.itemID), "bindingHash": .string($0.hash)]) }),
            "sends": .array(request.sends.map { .obj(["itemId": .string($0.itemID), "sendHash": .string($0.hash)]) }),
        ])
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
    static func nightShiftItem(_ item: JSONValue) -> NightShiftItem? {
        guard let id = item["id"]?.string, let hash = item["bindingHash"]?.string, !hash.isEmpty,
              let domain = item["domain"]?.string.flatMap(NightShiftDomain.init(rawValue:))
        else { return nil }
        let status = item["status"]?.string.flatMap(NightShiftItemStatus.init(rawValue:)) ?? .stale
        let preview = item["preview"]
        let previewObject = preview?.object.map { JSONValue.object($0) }
        // The whole draft is the frozen `body` argument. Past the phone's drawing limit it stays on the Mac.
        let fullText = item.at("params", "body")?.string
        let oversize = (fullText?.count ?? 0) > Self.nestedLimit || Self.detailsNeedMac(previewObject)
        let previewBody = preview?["body"]?.string
        let truncated = preview?["truncated"]?.bool == true
        let recipients = (preview?["to"]?.array ?? preview?["recipients"]?.array ?? []).compactMap(\.string).map(DisplaySafe.text)
        let send = item["send"].flatMap { send -> NightShiftSend? in
            guard let sendHash = send["contentHash"]?.string, !sendHash.isEmpty else { return nil }
            return NightShiftSend(
                recipients: (send["recipients"]?.array ?? []).compactMap(\.string).map(DisplaySafe.text), contentHash: sendHash)
        }
        return NightShiftItem(
            id: id, domain: domain, status: status, summary: DisplaySafe.text(item["summary"]?.string ?? ""),
            why: item["why"]?.string.map(DisplaySafe.text), bindingHash: hash, untrusted: item["taint"]?.bool == true,
            newRecipient: preview?["newRecipient"]?.bool == true || !(preview?["newRecipients"]?.array ?? []).isEmpty,
            replyAll: preview?["replyAll"]?.bool == true, truncated: truncated, recipients: recipients,
            subject: preview?["subject"]?.string.map(DisplaySafe.text),
            body: (previewBody ?? (truncated ? nil : fullText)).map(DisplaySafe.paragraphs),
            fullBody: oversize ? nil : fullText.map(DisplaySafe.paragraphs),
            lines: Self.nightShiftLines(preview), send: send, needsMac: oversize,
            reason: (item.at("result", "error")?.string).map(DisplaySafe.text))
    }

    /// Before/after rows from the preview: calendar `changes`, a file's `from` and `to`, or a reminder's `fields`.
    static func nightShiftLines(_ preview: JSONValue?) -> [NightShiftLine] {
        guard let preview else { return [] }
        func text(_ value: JSONValue?) -> String? {
            switch value {
            case .string(let s)?: DisplaySafe.text(s)
            case .number(let n)?: n == n.rounded() ? String(Int(n)) : String(n)
            case .bool(let b)?: b ? "true" : "false"
            default: nil
            }
        }
        var lines: [NightShiftLine] = []
        for change in preview["changes"]?.array ?? [] {
            guard let label = (change["label"]?.string ?? change["field"]?.string).map(DisplaySafe.text) else { continue }
            lines.append(NightShiftLine(label: label, before: text(change["before"]), after: text(change["after"])))
        }
        if let from = text(preview["from"]), let to = text(preview["to"]) {
            lines.append(NightShiftLine(label: "", before: from, after: to))
        }
        for (key, value) in (preview["fields"]?.object ?? [:]).sorted(by: { $0.key < $1.key }) {
            if let shown = text(value) { lines.append(NightShiftLine(label: DisplaySafe.text(key), after: shown)) }
        }
        return lines
    }
}
