import Foundation

/// Follow-ups and suggestions' fixture state. Acting on one moves it as the Gateway does: a follow-up leaves the
/// list, an approved suggestion is done (and can be undone once), and undo offers an inverse waiting for approval.
struct FollowupsState: Sendable {
    var followups = FixtureData.followups
    var suggestions = FixtureData.suggestions
}

extension FixtureData {
    // MARK: Follow-ups and suggestions

    public static let followups: [MailFollowup] = [
        MailFollowup(id: "mf_dana", kind: .noReply, who: "Dana Okafor", subject: "Q3 deck: the final numbers?", daysQuiet: 4),
        MailFollowup(id: "mf_lee", kind: .unansweredQuestion, who: "Lee Park", subject: "Still on for Thursday at 3?", daysQuiet: 2),
    ]

    public static let suggestions: [Suggestion] = [
        Suggestion(
            id: "sg_receipts", title: "Move October receipts to Receipts", status: .pending,
            callSummaries: ["Move 6 receipts: Receipts", "Mark read: Store receipts (Oct)"],
            reversible: true, fromOutsideContent: true, source: "mail.digest"),
        Suggestion(
            id: "sg_newsletters", title: "Mark the weekly newsletters read", status: .pending,
            callSummaries: ["Mark read: Weekly digest (Acme)", "Mark read: Morning reads"],
            reversible: true, fromOutsideContent: false, source: "workflows.habit"),
    ]
}

extension FixtureBackend: FollowupsBackend {
    public func mailFollowups() async throws -> [MailFollowup] {
        await pause()
        return followupsState.followups
    }

    public func actOnMailFollowup(id: String, action: MailFollowupAction) async throws {
        guard followupsState.followups.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        followupsState.followups.removeAll { $0.id == id }
        publish(.changed(.home))
    }

    public func suggestions() async throws -> [Suggestion] {
        await pause()
        return followupsState.suggestions.filter { $0.status == .pending || $0.status == .awaitingApproval }
    }

    public func suggestion(id: String) async throws -> Suggestion {
        await pause()
        guard let found = followupsState.suggestions.first(where: { $0.id == id }) else { throw BackendError.notFound }
        return found
    }

    public func approveSuggestion(id: String) async throws {
        let index = try suggestionIndex(id)
        guard followupsState.suggestions[index].status == .pending else {
            throw BackendError.refused("That suggestion is no longer waiting.")
        }
        followupsState.suggestions[index].status = .done
        publish(.changed(.home))
    }

    public func dismissSuggestion(id: String) async throws {
        let index = try suggestionIndex(id)
        followupsState.suggestions[index].status = .dismissed
        publish(.changed(.home))
    }

    public func undoSuggestion(id: String) async throws {
        let index = try suggestionIndex(id)
        let original = followupsState.suggestions[index]
        guard original.canUndo else { throw BackendError.refused("This can't be undone any more.") }
        followupsState.suggestions[index].undoOffered = true
        followupsState.suggestions.append(Suggestion(
            id: "undo_\(original.id)", title: "Undo: \(original.title)", status: .pending,
            callSummaries: original.callSummaries.map { "Undo: \($0)" }, reversible: true,
            source: original.source))
        publish(.changed(.home))
    }

    private func suggestionIndex(_ id: String) throws -> Int {
        guard let index = followupsState.suggestions.firstIndex(where: { $0.id == id }) else { throw BackendError.notFound }
        return index
    }
}
