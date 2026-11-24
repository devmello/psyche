import Foundation

/// Follow-ups and suggestions' fixture state. Acting on one moves it as the Gateway does: a follow-up leaves the
/// list, an approved suggestion is done (and can be undone once), and undo offers an inverse waiting for approval.
struct FollowupsState: Sendable {
    var followups = FixtureData.followups
    var suggestions = FixtureData.suggestions
    /// How many reads of a suggestion still see it `running` after its approval (the Gateway runs a batch after the
    /// answer). Zero: it is done at once. Tests set it to prove the model waits for the batch to settle.
    var runReads = 0
    var readsLeft: [String: Int] = [:]
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
        guard let index = followupsState.suggestions.firstIndex(where: { $0.id == id }) else { throw BackendError.notFound }
        if followupsState.suggestions[index].status == .running {
            let left = (followupsState.readsLeft[id] ?? 0) - 1
            followupsState.readsLeft[id] = left
            if left <= 0 { followupsState.suggestions[index].status = .done }
        }
        return followupsState.suggestions[index]
    }

    /// Test hook: after the next approval, the suggestion reads as `running` this many times before it is done.
    func setFollowupRunReads(_ reads: Int) { followupsState.runReads = reads }

    /// Test hook: a suggestion that already asked for its approval, which is waiting on Needs you.
    func awaitApproval(_ id: String) throws {
        let index = try suggestionIndex(id)
        followupsState.suggestions[index].status = .awaitingApproval
    }

    public func approveSuggestion(id: String) async throws -> NeedsYouItem? {
        let index = try suggestionIndex(id)
        if followupsState.suggestions[index].status == .awaitingApproval {
            // Its approval already waits on Needs you: that one is answered there, nothing is asked twice.
            guard let item = homeState.snapshot.needsYou.first(where: { $0.kind == .approval }) else {
                throw BackendError.refused("That suggestion is no longer waiting.")
            }
            return item
        }
        guard followupsState.suggestions[index].status == .pending else {
            throw BackendError.refused("That suggestion is no longer waiting.")
        }
        if followupsState.runReads > 0 {
            followupsState.suggestions[index].status = .running
            followupsState.readsLeft[id] = followupsState.runReads
        } else {
            followupsState.suggestions[index].status = .done
        }
        publish(.changed(.home))
        return nil
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
