import Foundation

/// Night shift's fixture state: one night waiting for review. Applying marks the ticked items applied and dismissing
/// marks them dismissed, as the Gateway does, so demo mode behaves; nothing leaves the phone.
struct NightShiftState: Sendable {
    var review = FixtureData.nightShiftReview
    /// Approvals this phone was asked to answer, so a test can see what a fixture apply bound.
    var applied: [NightShiftApplyRequest] = []
    var undone: [[String]] = []
}

extension FixtureData {
    // MARK: Night shift

    public static let nightShiftReviewID = "ns_2030_01_01"

    private static let teamBody =
        "Hi all,\n\nThursday at 3 works for me. I can bring the revised plan and walk through the open questions on staffing, the budget and the timeline.\n\nIf anyone needs the draft beforehand, say so and I will send it tonight.\n\nBest,\nAlex"

    /// The review as the Gateway sends it to a phone: an item from Messages arrives withheld.
    public static var nightShiftReview: NightShiftReview {
        NightShiftReview(
            id: nightShiftReviewID, night: "2030-01-01", expiresAt: Date.now.addingTimeInterval(3 * 86_400),
            items: [
                NightShiftItem(
                    id: "ns_mail_dana", domain: .mail, tool: "mail_draft", summary: "Reply to Dana about the Q3 deck",
                    why: "Dana asked for the final numbers four days ago.", bindingHash: "sha256:dana-draft", untrusted: true,
                    rows: [
                        NightShiftRow(label: "Recipient", value: "dana@acme.example"),
                        NightShiftRow(label: "Subject", value: "Re: Q3 deck: the final numbers?"),
                        NightShiftRow(
                            label: "Body",
                            value: "Hi Dana,\n\nThe final numbers are in the attached sheet. Revenue closed at 4.2M.\n\nBest,\nAlex"),
                    ],
                    fullBody: "Hi Dana,\n\nThe final numbers are in the attached sheet. Revenue closed at 4.2M.\n\nBest,\nAlex",
                    send: NightShiftSend(recipients: ["dana@acme.example"], contentHash: "sha256:dana-send")),
                NightShiftItem(
                    id: "ns_mail_team", domain: .mail, tool: "mail_draft", summary: "Reply to the Thursday planning thread",
                    why: "Lee asked whether Thursday at 3 still works.", bindingHash: "sha256:team-draft", untrusted: true,
                    rows: [
                        NightShiftRow(label: "Reply all", value: "yes", badge: .replyAll),
                        NightShiftRow(label: "Recipient", value: "lee@park.example"),
                        NightShiftRow(label: "Recipient", value: "sam@newco.example", badge: .newRecipient),
                        NightShiftRow(label: "Recipient", value: "ops@acme.example"),
                        NightShiftRow(label: "Subject", value: "Re: Still on for Thursday at 3?"),
                        NightShiftRow(
                            label: "Body", value: "Hi all,\n\nThursday at 3 works for me. I can bring the revised plan and walk through the open",
                            truncated: true),
                    ],
                    truncated: true, fullBody: teamBody,
                    send: NightShiftSend(
                        recipients: ["lee@park.example", "sam@newco.example", "ops@acme.example"],
                        contentHash: "sha256:team-send")),
                NightShiftItem(
                    id: "ns_mail_gmail", domain: .mail, tool: "gmail_create_draft", summary: "Reply to the landlord about the lease",
                    bindingHash: "sha256:gmail-draft", untrusted: true,
                    rows: [
                        NightShiftRow(label: "Recipient", value: "landlord@homes.example"),
                        NightShiftRow(label: "Subject", value: "Re: Lease renewal"),
                        NightShiftRow(label: "Body", value: "Hi, I will send the signed lease by Friday."),
                    ],
                    fullBody: "Hi, I will send the signed lease by Friday.",
                    // A Gmail draft can't be read back, so the Gateway refuses its send: no box is offered.
                    send: NightShiftSend(recipients: ["landlord@homes.example"], contentHash: "sha256:gmail-send")),
                NightShiftItem(
                    id: "ns_cal_dentist", domain: .calendar, tool: "calendar_update_event",
                    summary: "Move the dentist so it doesn't overlap the 1:1", why: "Both are on Tuesday at 10:00.",
                    bindingHash: "sha256:cal-dentist",
                    rows: [
                        NightShiftRow(label: "Event", value: "Dentist"),
                        NightShiftRow(label: "start", value: "Tue 10:00 -> Tue 11:00"),
                        NightShiftRow(label: "end", value: "Tue 11:00 -> Tue 12:00"),
                    ]),
                NightShiftItem(
                    id: "ns_file_receipt", domain: .files, tool: "files_move", summary: "File the October receipt",
                    bindingHash: "sha256:file-receipt",
                    rows: [
                        NightShiftRow(label: "From", value: "Downloads/receipt-oct.pdf"),
                        NightShiftRow(label: "To", value: "Documents/Receipts/2030/receipt-oct.pdf"),
                    ]),
                NightShiftItem(
                    id: "ns_rem_lease", domain: .reminders, tool: "reminders_create", summary: "Remind you to send the signed lease",
                    why: "You said you would send it by Friday.", bindingHash: "sha256:rem-lease",
                    rows: [NightShiftRow(label: "Due", value: "Fri 9:00")]),
                // Made from the owner's Messages: a phone gets only the generic line, and the Gateway refuses to apply it here.
                NightShiftItem(
                    id: "ns_rem_messages", domain: .reminders, tool: "reminders_create",
                    summary: "An item from your Messages. Open Psyche on this Mac to see it.", bindingHash: "sha256:rem-msg",
                    withheldMessages: true),
                NightShiftItem(
                    id: "ns_cal_stale", domain: .calendar, status: .stale, tool: "calendar_create_event", summary: "Add the design review",
                    bindingHash: "sha256:cal-stale", reason: "The event changed since last night."),
            ])
    }
}

extension FixtureBackend: NightShiftBackend {
    public func nightShiftStatus() async throws -> NightShiftStatus {
        await pause()
        let review = nightShiftState.review
        var counts = NightShiftCounts()
        for item in review.items where item.status == .ready {
            switch item.domain {
            case .mail: counts.mail += 1
            case .calendar: counts.calendar += 1
            case .reminders: counts.reminders += 1
            case .files: counts.files += 1
            }
        }
        guard counts.total > 0 else { return NightShiftStatus(enabled: true) }
        return NightShiftStatus(enabled: true, counts: counts, readyReviewID: review.id, expiresAt: review.expiresAt)
    }

    public func nightShiftReview(id: String) async throws -> NightShiftReview {
        await pause()
        guard id == nightShiftState.review.id else { throw BackendError.notFound }
        return nightShiftState.review
    }

    public func applyNightShift(_ request: NightShiftApplyRequest) async throws -> NightShiftApplyOutcome {
        guard request.reviewID == nightShiftState.review.id else { throw BackendError.notFound }
        var refused: [NightShiftRefusal] = []
        for tick in request.items {
            guard let index = nightShiftState.review.items.firstIndex(where: { $0.id == tick.itemID }) else {
                refused.append(NightShiftRefusal(itemID: tick.itemID, reason: "That item is gone."))
                continue
            }
            let item = nightShiftState.review.items[index]
            // The Gateway refuses an item from Messages for any caller that is not the desktop app on the Mac.
            if item.withheldMessages {
                refused.append(NightShiftRefusal(
                    itemID: tick.itemID, reason: "items from your Messages can be applied only in Psyche on this Mac"))
                continue
            }
            guard item.status == .ready, !item.applying, item.bindingHash == tick.hash else {
                refused.append(NightShiftRefusal(itemID: tick.itemID, reason: "That item changed since you looked."))
                continue
            }
            nightShiftState.review.items[index].status = .applied
            nightShiftState.review.items[index].canUndo = item.domain == .reminders || item.domain == .files
            nightShiftState.review.items[index].sent = request.sends.contains { $0.itemID == tick.itemID }
        }
        nightShiftState.applied.append(request)
        publish(.changed(.home))
        return .answered(refused: refused)
    }

    public func undoNightShift(itemIDs: [String]) async throws -> NightShiftApplyOutcome {
        var refused: [NightShiftRefusal] = []
        for id in itemIDs {
            guard let index = nightShiftState.review.items.firstIndex(where: { $0.id == id }),
                  nightShiftState.review.items[index].canUndo
            else {
                refused.append(NightShiftRefusal(itemID: id, reason: "That can't be undone any more."))
                continue
            }
            nightShiftState.review.items[index].status = .undone
            nightShiftState.review.items[index].canUndo = false
        }
        nightShiftState.undone.append(itemIDs)
        publish(.changed(.home))
        return .answered(refused: refused)
    }

    public func dismissNightShift(reviewID: String, itemIDs: [String]?) async throws {
        guard reviewID == nightShiftState.review.id else { throw BackendError.notFound }
        for index in nightShiftState.review.items.indices {
            let item = nightShiftState.review.items[index]
            guard item.status == .ready, !item.applying, itemIDs?.contains(item.id) ?? true else { continue }
            nightShiftState.review.items[index].status = .dismissed
        }
        publish(.changed(.home))
    }
}
