import Foundation

/// Night shift's fixture state: one night waiting for review. Applying marks the ticked items applied and dismissing
/// marks them dismissed, as the Gateway does, so demo mode behaves; nothing leaves the phone.
struct NightShiftState: Sendable {
    var review = FixtureData.nightShiftReview
    /// Approvals this phone was asked to answer, so a test can see what a fixture apply bound.
    var applied: [NightShiftApplyRequest] = []
}

extension FixtureData {
    // MARK: Night shift

    public static let nightShiftReviewID = "ns_2030_01_01"

    /// A fixed future-proof date, so a fixture never shows an absurd countdown against the wall clock.
    public static var nightShiftReview: NightShiftReview {
        NightShiftReview(
            id: nightShiftReviewID, night: "2030-01-01", expiresAt: Date.now.addingTimeInterval(3 * 86_400),
            items: [
                NightShiftItem(
                    id: "ns_mail_dana", domain: .mail, summary: "Reply to Dana about the Q3 deck",
                    why: "Dana asked for the final numbers four days ago.", bindingHash: "sha256:dana-draft",
                    untrusted: true, recipients: ["dana@acme.example"], subject: "Re: Q3 deck: the final numbers?",
                    body: "Hi Dana,\n\nThe final numbers are in the attached sheet. Revenue closed at 4.2M.\n\nBest,\nAlex",
                    fullBody: "Hi Dana,\n\nThe final numbers are in the attached sheet. Revenue closed at 4.2M.\n\nBest,\nAlex",
                    send: NightShiftSend(recipients: ["dana@acme.example"], contentHash: "sha256:dana-send")),
                NightShiftItem(
                    id: "ns_mail_team", domain: .mail, summary: "Reply to the Thursday planning thread",
                    why: "Lee asked whether Thursday at 3 still works.", bindingHash: "sha256:team-draft",
                    untrusted: true, newRecipient: true, replyAll: true, truncated: true,
                    recipients: ["lee@park.example", "sam@newco.example", "ops@acme.example"],
                    subject: "Re: Still on for Thursday at 3?",
                    body: "Hi all,\n\nThursday at 3 works for me. I can bring the revised plan and walk through the open",
                    fullBody: "Hi all,\n\nThursday at 3 works for me. I can bring the revised plan and walk through the open questions on staffing, the budget and the timeline.\n\nIf anyone needs the draft beforehand, say so and I will send it tonight.\n\nBest,\nAlex",
                    send: NightShiftSend(
                        recipients: ["lee@park.example", "sam@newco.example", "ops@acme.example"],
                        contentHash: "sha256:team-send")),
                NightShiftItem(
                    id: "ns_cal_dentist", domain: .calendar, summary: "Move the dentist so it doesn't overlap the 1:1",
                    why: "Both are on Tuesday at 10:00.", bindingHash: "sha256:cal-dentist",
                    lines: [
                        NightShiftLine(label: "Starts", before: "Tue 10:00", after: "Tue 11:00"),
                        NightShiftLine(label: "Ends", before: "Tue 11:00", after: "Tue 12:00"),
                    ]),
                NightShiftItem(
                    id: "ns_file_receipt", domain: .files, summary: "File the October receipt",
                    bindingHash: "sha256:file-receipt",
                    lines: [NightShiftLine(label: "", before: "Downloads/receipt-oct.pdf", after: "Documents/Receipts/2030/receipt-oct.pdf")]),
                NightShiftItem(
                    id: "ns_rem_lease", domain: .reminders, summary: "Remind you to send the signed lease",
                    why: "You said you would send it by Friday.", bindingHash: "sha256:rem-lease",
                    lines: [NightShiftLine(label: "Due", after: "Fri 9:00")]),
                NightShiftItem(
                    id: "ns_cal_stale", domain: .calendar, status: .stale, summary: "Add the design review",
                    bindingHash: "sha256:cal-stale", reason: "The event changed since last night."),
            ])
    }
}

extension FixtureBackend: NightShiftBackend {
    public func nightShiftStatus() async throws -> NightShiftStatus {
        await pause()
        let review = nightShiftState.review
        let live = review.items.filter { $0.status == .ready || $0.status == .stale }
        guard live.contains(where: { $0.status == .ready }) else { return NightShiftStatus(enabled: true) }
        var counts = NightShiftCounts()
        for item in live where item.status == .ready {
            switch item.domain {
            case .mail: counts.mail += 1
            case .calendar: counts.calendar += 1
            case .reminders: counts.reminders += 1
            case .files: counts.files += 1
            }
        }
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
            guard item.status == .ready, item.bindingHash == tick.hash else {
                refused.append(NightShiftRefusal(itemID: tick.itemID, reason: "That item changed since you looked."))
                continue
            }
            nightShiftState.review.items[index].status = .applied
        }
        nightShiftState.applied.append(request)
        publish(.changed(.home))
        return .answered(refused: refused)
    }

    public func dismissNightShift(reviewID: String, itemIDs: [String]?) async throws {
        guard reviewID == nightShiftState.review.id else { throw BackendError.notFound }
        for index in nightShiftState.review.items.indices {
            let item = nightShiftState.review.items[index]
            guard item.status == .ready, itemIDs?.contains(item.id) ?? true else { continue }
            nightShiftState.review.items[index].status = .dismissed
        }
        publish(.changed(.home))
    }
}
