import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The morning review: every change Night shift prepared, one checkbox each, and one Apply. Everything drawn here is the
/// Gateway's item data as plain text (`Text(verbatim:)`: no markdown, no links). Select all never ticks a send; a send
/// is its own box under its draft and starts off. Stale, refused and too-large items can't be ticked.
struct NightShiftReviewView: View {
    @State private var model: NightShiftReviewModel
    @State private var open: Set<String> = []
    @Environment(Session.self) private var session

    init(reviewID: String, store: any PsycheBackend) {
        _model = State(initialValue: NightShiftReviewModel(reviewID: reviewID, store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                if let banner = model.banner { bannerView(banner) }
                if let expiresAt = model.expiresAt, !model.items.isEmpty {
                    EvidenceLine([String(localized: "Items expire \(expiresAt.formatted(.dateTime.weekday().hour().minute()))", bundle: .module)])
                }
                PhaseView(phase: model.phase, skeleton: Self.skeleton, retry: model.load) { review in
                    content(review)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .navigationTitle(String(localized: "Prepared overnight", bundle: .module))
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        .safeAreaInset(edge: .bottom) { footer }
        .task {
            await model.load()
            await model.observe()
        }
        .refreshable { await model.load() }
    }

    private static let skeleton = NightShiftReview(
        id: "", night: "", items: [NightShiftItem(id: "s", domain: .mail, summary: "Reply to someone about something", bindingHash: "s")])

    // MARK: Content

    @ViewBuilder
    private func content(_: NightShiftReview) -> some View {
        if model.items.isEmpty {
            Text("Nothing is waiting for review.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
        } else {
            ForEach(NightShiftDomain.allCases, id: \.self) { domain in
                let items = model.group(domain)
                if !items.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader(NightShiftText.title(domain), count: items.count)
                        PaperCard {
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                if index > 0 { HairlineDivider() }
                                row(item)
                            }
                        }
                    }
                }
            }
        }
    }

    private func row(_ item: NightShiftItem) -> some View {
        let ticked = model.selection.ticked.contains(item.id)
        let selectable = model.selection.canTick(item)
        let expanded = open.contains(item.id)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Button { model.toggle(item) } label: { box(on: ticked, enabled: selectable) }
                    .buttonStyle(.plain)
                    .disabled(!selectable || model.busy)
                    .accessibilityLabel(Text("Apply this change", bundle: .module))
                    .accessibilityValue(ticked ? Text("On", bundle: .module) : Text("Off", bundle: .module))
                VStack(alignment: .leading, spacing: 6) {
                    // An item from Messages is drawn as our own localized line: the Gateway's text is only a fallback.
                    Text(verbatim: item.withheldMessages ? NightShiftText.withheldLine : item.summary)
                        .font(.psycheRow).foregroundStyle(selectable ? PsycheColor.text : PsycheColor.muted)
                    badges(item)
                    if let why = item.why, !why.isEmpty { EvidenceLine([why]) }
                    status(item)
                    if item.withheldMessages {
                        Text("Open on your Mac to apply", bundle: .module)
                            .font(.footnote).foregroundStyle(PsycheColor.muted)
                    } else if item.needsMac {
                        Text("Too long to review here. Open it on your Mac.", bundle: .module)
                            .font(.footnote).foregroundStyle(PsycheColor.muted)
                    } else if (item.status == .ready || item.status == .stale) && !item.rows.isEmpty {
                        Button {
                            if expanded { open.remove(item.id) } else { open.insert(item.id) }
                        } label: {
                            Group {
                                if expanded { Text("Hide details", bundle: .module) } else { Text("Show details", bundle: .module) }
                            }
                            .font(.footnote.weight(.medium))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(PsycheColor.muted)
                    }
                    if expanded && !item.needsMac { details(item) }
                }
            }
            if item.canOfferSend, item.status == .ready, !item.needsMac, !item.withheldMessages, !item.applying { sendBox(item) }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private func box(on: Bool, enabled: Bool) -> some View {
        Image(systemName: on ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 22))
            .foregroundStyle(on ? PsycheColor.inkText : PsycheColor.muted.opacity(enabled ? 0.8 : 0.35))
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
    }

    /// New recipient and Reply all are never tucked into the details: they are the two things a send can get wrong.
    @ViewBuilder
    private func badges(_ item: NightShiftItem) -> some View {
        HStack(spacing: 14) {
            if item.newRecipient { StatusDot(.needsYou, String(localized: "New recipient", bundle: .module)) }
            if item.replyAll { StatusDot(.needsYou, String(localized: "Reply all", bundle: .module)) }
            if item.status == .stale { StatusDot(.neutral, String(localized: "Stale", bundle: .module)) }
            if item.untrusted { StatusDot(.neutral, String(localized: "Untrusted source", bundle: .module)) }
        }
    }

    @ViewBuilder
    private func status(_ item: NightShiftItem) -> some View {
        switch item.status {
        case .applied:
            if item.sent { StatusDot(.done, String(localized: "Applied and sent", bundle: .module)) }
            else { StatusDot(.done, String(localized: "Applied", bundle: .module)) }
            if item.canUndo {
                Button { Task { await model.undo(item) } } label: {
                    Text("Undo", bundle: .module).font(.footnote.weight(.semibold))
                }
                .buttonStyle(.plain).foregroundStyle(PsycheColor.inkText)
                .disabled(model.busy || !session.state.canAnswer)
            }
        case .failed: StatusDot(.failed, NightShiftText.failedNote(item.reason))
        case .uncertain: StatusDot(.needsYou, String(localized: "Check in the app", bundle: .module))
        case .stale, .superseded:
            Text(verbatim: item.reason ?? String(localized: "This changed since it was prepared.", bundle: .module))
                .font(.footnote).foregroundStyle(PsycheColor.muted)
        case .skipped: StatusDot(.neutral, String(localized: "Skipped", bundle: .module))
        case .undone: StatusDot(.neutral, String(localized: "Undone", bundle: .module))
        case .ready:
            // An apply is open for it right now: it can't be ticked or dismissed until that settles.
            if item.applying { StatusDot(.needsYou, String(localized: "Applying…", bundle: .module)) }
        case .dismissed, .expired: EmptyView()
        }
        if let note = NightShiftText.resultNote(item) {
            Text(verbatim: note).font(.footnote).foregroundStyle(PsycheColor.muted)
        }
        if let refusal = model.selection.refused[item.id] {
            Text(verbatim: refusal.isEmpty ? String(localized: "Psyche left this one out.", bundle: .module) : refusal)
                .font(.footnote).foregroundStyle(PsycheColor.muted)
        }
    }

    // MARK: Details (plain text)

    /// The preview's rows, in the order the Gateway sent them. A draft's body shows its whole text once opened.
    private func details(_ item: NightShiftItem) -> some View {
        let full = model.selection.expanded.contains(item.id)
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(item.rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.label).font(.footnote).foregroundStyle(PsycheColor.muted)
                    Text(verbatim: full && row.label == "Body" ? (item.fullBody ?? row.value) : row.value)
                        .font(.callout).foregroundStyle(PsycheColor.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if item.truncated {
                if full {
                    EmptyView()
                } else if item.fullBody != nil {
                    Button { model.expand(item) } label: {
                        Text("Show full draft", bundle: .module).font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(.plain).foregroundStyle(PsycheColor.inkText)
                } else {
                    Text("The whole draft is too long to show here. Open it on your Mac.", bundle: .module)
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
        }
    }

    // MARK: Send box

    /// "Send it too": its own box under the draft. Off by default, never part of Select all, and not tickable until the
    /// draft is ticked and (when its preview is cut short) the whole text has been opened.
    private func sendBox(_ item: NightShiftItem) -> some View {
        let on = model.selection.sendTicked.contains(item.id)
        let enabled = model.selection.canTickSend(item)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 12) {
                Button { model.toggleSend(item) } label: { box(on: on, enabled: enabled) }
                    .buttonStyle(.plain)
                    .disabled(!enabled || model.busy)
                    .accessibilityLabel(Text("Send it too", bundle: .module))
                    .accessibilityValue(on ? Text("On", bundle: .module) : Text("Off", bundle: .module))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Send it too", bundle: .module).font(.subheadline.weight(.semibold))
                        .foregroundStyle(enabled ? PsycheColor.text : PsycheColor.muted)
                    if let send = item.send {
                        Text(verbatim: send.recipients.joined(separator: ", ")).font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                    if item.truncated && !model.selection.expanded.contains(item.id) {
                        Text("Show the full draft to turn this on.", bundle: .module)
                            .font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
        }
        .padding(.leading, 44)
    }

    // MARK: Banner and footer

    @ViewBuilder
    private func bannerView(_ banner: NightShiftReviewModel.Banner) -> some View {
        switch banner {
        case .applying(let count):
            StatusDot(.done, String(localized: "Approved. Psyche is applying \(count) changes.", bundle: .module))
        case .needsMac:
            StatusDot(.needsYou, String(localized: "This one needs your Mac. Answer it there.", bundle: .module))
        case .mismatch:
            StatusDot(.failed, String(localized: "What Psyche asked to approve doesn't match what you ticked, so nothing was applied. Review it again.", bundle: .module))
        case .failure(let message):
            if !message.isEmpty { StatusDot(.failed, message) }
        }
    }

    private var footer: some View {
        let count = model.pending.items.count
        return VStack(spacing: 10) {
            HStack(spacing: 20) {
                Button(String(localized: "Select all", bundle: .module)) { model.selectAll() }
                Button(String(localized: "Clear", bundle: .module)) { model.clear() }
                    .disabled(model.selection.ticked.isEmpty)
                Spacer(minLength: 0)
                Button(String(localized: "Dismiss the rest", bundle: .module)) {
                    Task { await model.dismissRest() }
                }
                .disabled(!model.canDismissRest || model.busy)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(PsycheColor.muted)
            .buttonStyle(.plain)
            Button(String(localized: "Apply selected (\(count))", bundle: .module)) {
                Task { await model.apply() }
            }
            .buttonStyle(.psycheInk)
            .disabled(count == 0 || model.busy || !session.state.canAnswer)
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.vertical, 12)
        .background(PsycheColor.paper)
    }
}
