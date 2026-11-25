import PsycheDesign
import PsycheStore
import SwiftUI

/// Home's "Prepared overnight" section: what Night shift got ready, in counts and the first lines, and one Review row.
/// Drawn only while a review is waiting. It changes nothing: Review opens the screen where every change is read
/// before anything is ticked. A list section: Home owns the model (and its load), so an empty section still loads.
struct NightShiftHomeSection: View {
    let model: NightShiftCardModel
    @Environment(Router.self) private var router

    var body: some View {
        if let reviewID = model.reviewID, let status = model.status {
            Section {
                Button { router.homePath.append(.nightShift(id: reviewID)) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: NightShiftText.countsLine(status.counts)).font(.body)
                        ForEach(Array(model.firstLines.enumerated()), id: \.offset) { _, line in
                            Text(verbatim: line).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Text("Review", bundle: .module)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.tint)
                            .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("home.nightshift.review")
            } header: {
                Text("Prepared overnight", bundle: .module)
            }
        }
    }
}

/// Words for the card and the screen. Counts are written with plural forms in each language's catalog.
enum NightShiftText {
    /// "3 reply drafts · 2 calendar fixes · 1 filed document", only the kinds that have something.
    static func countsLine(_ counts: NightShiftCounts) -> String {
        var parts: [String] = []
        if counts.mail > 0 { parts.append(String(localized: "\(counts.mail) reply drafts", bundle: .module)) }
        if counts.calendar > 0 { parts.append(String(localized: "\(counts.calendar) calendar fixes", bundle: .module)) }
        if counts.reminders > 0 { parts.append(String(localized: "\(counts.reminders) reminders", bundle: .module)) }
        if counts.files > 0 { parts.append(String(localized: "\(counts.files) filed documents", bundle: .module)) }
        return parts.joined(separator: " · ")
    }

    /// The generic line for an item made from the owner's Messages (the Gateway shows a phone only a fallback of it).
    static var withheldLine: String {
        String(localized: "An item from your Messages. Open on your Mac to apply.", bundle: .module)
    }

    /// The Gateway's result notes are English and start with a fixed prefix; each one the phone knows is drawn in the
    /// app's language: a refused undo, a send that stopped before anything left the Mac, a send that may not have gone.
    static func localizedResult(_ reason: String?) -> String? {
        guard let reason else { return nil }
        if reason.hasPrefix("undo refused:") {
            return String(localized: "Couldn't undo this. It changed after it was applied.", bundle: .module)
        }
        if reason.hasPrefix("send before_effect:") {
            return String(localized: "The draft was saved but not sent. Nothing left your Mac.", bundle: .module)
        }
        if reason.hasPrefix("send:") {
            return String(localized: "The draft was saved. The send may not have gone through: check Mail.", bundle: .module)
        }
        return nil
    }

    /// A line under an item that is not failed (an applied item whose undo was refused, or whose send stopped).
    static func resultNote(_ item: NightShiftItem) -> String? {
        item.status == .failed ? nil : localizedResult(item.reason)
    }

    /// What a failed item says: a known note in the app's language, else the Gateway's own words.
    static func failedNote(_ reason: String?) -> String {
        localizedResult(reason) ?? reason ?? String(localized: "Failed", bundle: .module)
    }

    static func title(_ domain: NightShiftDomain) -> String {
        switch domain {
        case .mail: String(localized: "Replies", bundle: .module)
        case .calendar: String(localized: "Calendar", bundle: .module)
        case .reminders: String(localized: "Reminders", bundle: .module)
        case .files: String(localized: "Files", bundle: .module)
        }
    }
}
