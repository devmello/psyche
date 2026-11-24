import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Home's follow-ups and suggestions over `mailFollowups.*` and `proposals.*`. A suggestion's one batch approval is
// answered here with the token `proposals.approve` hands this phone, so the owner's single tap runs it.
extension GatewayBackend {
    public func mailFollowups() async throws -> [MailFollowup] {
        let result = try await call("mailFollowups.list", .obj([:]))
        // Off, or no mail connected: the Gateway lists nothing, and the section stays hidden.
        guard result["enabled"]?.bool == true else { return [] }
        return (result["items"]?.array ?? []).compactMap(Self.mailFollowup(_:))
    }

    public func actOnMailFollowup(id: String, action: MailFollowupAction) async throws {
        _ = try await call("mailFollowups.act", Self.mailFollowupActParams(id: id, action: action))
    }

    public func suggestions() async throws -> [Suggestion] {
        let result = try await call("proposals.list", Self.suggestionListParams)
        return (result["proposals"]?.array ?? []).compactMap(Self.suggestion(_:))
    }

    public func suggestion(id: String) async throws -> Suggestion {
        let result = try await call("proposals.get", Self.suggestionIDParams(id))
        guard let proposal = result["proposal"], let suggestion = Self.suggestion(proposal) else { throw BackendError.notFound }
        return suggestion
    }

    @discardableResult
    public func approveSuggestion(id: String) async throws -> NeedsYouItem? {
        let result = try await call("proposals.approve", Self.suggestionIDParams(id))
        guard let approval = result["approval"], let approvalID = approval["id"]?.string else { throw BackendError.notFound }
        // A payment, or details too large to show in full here, is never answered from the phone: hand it to the
        // approval sheet, which keeps the Mac-only and presence rules. Nothing is sent to approvals.answer.
        if approval["requiresAuthentication"]?.bool == true || Self.detailsNeedMac(approval["details"]) {
            return Self.needsYou(approval: approval, holdsAnswer: false)
        }
        // The token is this phone's single-use answer for the batch approval. Without one the Mac has to answer.
        guard let token = result["answerToken"]?.string else { throw BackendError.refused("This one needs your Mac. Answer it there.") }
        _ = try await call("approvals.answer", Self.suggestionAnswerParams(approvalID: approvalID, token: token))
        return nil
    }

    public func dismissSuggestion(id: String) async throws {
        _ = try await call("proposals.dismiss", Self.suggestionIDParams(id))
    }

    public func undoSuggestion(id: String) async throws {
        _ = try await call("proposals.undo", Self.suggestionIDParams(id))
    }

    // MARK: - Params (static, so tests pin the wire shape)

    static func mailFollowupActParams(id: String, action: MailFollowupAction) -> JSONValue {
        .obj(["id": .string(id), "action": .string(action.rawValue)])
    }

    static var suggestionListParams: JSONValue {
        .obj(["status": .array([.string("pending"), .string("awaiting_approval")])])
    }

    static func suggestionIDParams(_ id: String) -> JSONValue {
        .obj(["proposalId": .string(id)])
    }

    static func suggestionAnswerParams(approvalID: String, token: String) -> JSONValue {
        .obj([
            "approvalId": .string(approvalID), "answerToken": .string(token),
            "decision": .string("approve"), "scope": .string("once"),
        ])
    }

    // MARK: - Mapping

    /// The tools whose batches can be undone by an inverse batch (mark read or unread, move, flag). The Mac's rule.
    static let reversibleTools: Set<String> = [
        "mail_mark_read", "mail_mark_unread", "mail_move", "mail_flag", "mail_unflag", "gmail_modify",
    ]

    static func mailFollowup(_ item: JSONValue) -> MailFollowup? {
        guard let id = item["id"]?.string,
              let kind = item["kind"]?.string.flatMap(MailFollowup.Kind.init(rawValue:)),
              let who = item["who"]?.string,
              let subject = item["subject"]?.string,
              let days = item["daysQuiet"]?.double
        else { return nil }
        // Names and subjects are third-party text: made safe like the other lines the phone shows.
        return MailFollowup(
            id: id, kind: kind, who: DisplaySafe.text(who), subject: DisplaySafe.text(subject),
            daysQuiet: max(0, Int(days)))
    }

    static func suggestion(_ p: JSONValue) -> Suggestion? {
        guard let id = p["id"]?.string, let title = p["title"]?.string,
              let status = p["status"]?.string.flatMap(Suggestion.Status.init(rawValue:)),
              let calls = p["calls"]?.array
        else { return nil }
        let tools = calls.compactMap { $0["tool"]?.string }
        let summaries = calls.compactMap { $0["summary"]?.string.map(DisplaySafe.text) }
        return Suggestion(
            id: id, title: DisplaySafe.text(title), status: status, callSummaries: summaries,
            reversible: !tools.isEmpty && tools.allSatisfy(reversibleTools.contains),
            // `undoOf` is set once the inverse has been offered: Undo goes away then, as on the Mac.
            undoOffered: p["undoOf"]?.string != nil,
            fromOutsideContent: p["taint"]?.bool == true,
            source: p.at("createdBy", "job")?.string ?? "")
    }
}
