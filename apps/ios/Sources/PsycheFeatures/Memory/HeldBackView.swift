import PsycheDesign
import PsycheStore
import SwiftUI

// The review queue on the Memory tab: "Held back" (items the Mac kept out of memory, with Release, Discard and Block
// sender) and "Trusted senders" (offers to accept a contact's self-disclosures, and the ones already trusted).
// Excerpts and names come from outside sources, so they are shown with `Text(verbatim:)` only: never Markdown,
// links or data detectors. Discard and Block sender ask first; every other tap is plain.

/// The Mac's wording for each quarantine reason (memoryReview.quarantine.reason.*). An unknown id gets the generic line.
private func reasonLabel(_ reason: String) -> String {
    switch reason {
    case "instruction_like": return String(localized: "Reads like an instruction", bundle: .module)
    case "hidden_text": return String(localized: "Had hidden text", bundle: .module)
    case "claims_about_owner": return String(localized: "Makes claims about you", bundle: .module)
    case "identity_claim": return String(localized: "Claims to be someone", bundle: .module)
    case "relation_change": return String(localized: "Asks to change a relationship", bundle: .module)
    case "too_many_claims": return String(localized: "Too many claims in one item", bundle: .module)
    case "sender_limit": return String(localized: "Too many from one sender", bundle: .module)
    case "item_too_large": return String(localized: "Too large", bundle: .module)
    case "schema_invalid": return String(localized: "Could not be read safely", bundle: .module)
    case "new_sender_sensitive": return String(localized: "Sensitive, from a new sender", bundle: .module)
    case "subject_mismatch": return String(localized: "Names someone it is not about", bundle: .module)
    default: return String(localized: "Held for review", bundle: .module)
    }
}

/// The item's date for the "From ..." line, in the phone's own format. Falls back to the raw text.
private func shortDate(_ iso: String) -> String {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    guard let date = fractional.date(from: iso) ?? plain.date(from: iso) else { return iso }
    return date.formatted(date: .abbreviated, time: .omitted)
}

@MainActor @Observable
final class HeldBackModel {
    /// Held items, a page at a time, newest first (memory.quarantine.list).
    let held: PagedRows<HeldItem>
    private(set) var senders: LoadPhase<[SenderTrustRow]> = .idle
    /// Shown in an alert when a write fails.
    var notice: String?

    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        held = PagedRows { cursor in
            let page = try await store.heldItemsPage(cursor: cursor)
            return (page.items, page.nextCursor)
        }
    }

    func loadSenders() async {
        if senders.value == nil { senders = .loading }
        do {
            senders = .loaded(try await store.senderTrust())
        } catch {
            if senders.value == nil { senders = .failed(error.localizedDescription) }
        }
    }

    /// Releases, discards or blocks the sender of a held item, then reloads what it changed.
    func act(_ item: HeldItem, _ action: HeldItemAction) async {
        do {
            try await store.decideHeldItem(id: item.id, action: action)
        } catch {
            notice = error.localizedDescription
            return
        }
        await held.reload()
        if action == .blockSender { await loadSenders() }
    }

    func decide(_ sender: SenderTrustRow, _ decision: SenderDecision) async {
        do {
            try await store.decideSender(entityID: sender.entityID, decision: decision)
        } catch {
            notice = error.localizedDescription
            return
        }
        await loadSenders()
    }
}

struct HeldBackView: View {
    @State private var model: HeldBackModel
    @State private var confirmingDiscard = false
    @State private var pendingDiscard: HeldItem?
    @State private var confirmingBlock = false
    @State private var pendingBlock: HeldItem?

    init(store: any PsycheBackend) {
        _model = State(initialValue: HeldBackModel(store: store))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Text("Review", bundle: .module).psycheTitle().padding(.bottom, 16)
                heldSection
                senderSection
            }
            .padding(PsycheMetrics.pagePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .alert(
            String(localized: "Couldn't update", bundle: .module),
            isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
        ) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(verbatim: model.notice ?? "")
        }
    }

    // Each row and the end sentinel are direct children of the LazyVStack: an inner stack would load every page at
    // once (#1624). The `.task` and the dialogs sit on the header, not on a group.
    @ViewBuilder
    private var heldSection: some View {
        let pager = model.held
        Text("Held back", bundle: .module).font(.headline).foregroundStyle(PsycheColor.text)
            .padding(.top, 8).padding(.bottom, 4)
            .task { await pager.reload() }
            .confirmationDialog(
                String(localized: "Discard this item?", bundle: .module), isPresented: $confirmingDiscard,
                titleVisibility: .visible
            ) {
                Button(String(localized: "Discard", bundle: .module), role: .destructive) {
                    if let item = pendingDiscard { Task { await model.act(item, .discard) } }
                }
                Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
            } message: {
                Text("It stays out of memory.", bundle: .module)
            }
            .confirmationDialog(
                String(localized: "Block this sender?", bundle: .module), isPresented: $confirmingBlock,
                titleVisibility: .visible
            ) {
                Button(String(localized: "Block sender", bundle: .module), role: .destructive) {
                    if let item = pendingBlock { Task { await model.act(item, .blockSender) } }
                }
                Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
            } message: {
                Text("Nothing else from them will be remembered.", bundle: .module)
            }
        Text("Text Psyche kept out of memory. Nothing is remembered from it until you release it.", bundle: .module)
            .font(.subheadline).foregroundStyle(PsycheColor.muted).padding(.bottom, 12)
        switch pager.phase {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 12)
        case .failed:
            FailedNotice { Task { await pager.reload() } }
        case .loaded(let rows) where rows.isEmpty:
            Text("Nothing is held back.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        case .loaded(let rows):
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                HeldItemRow(
                    item: item,
                    release: { Task { await model.act(item, .release) } },
                    discard: {
                        pendingDiscard = item
                        confirmingDiscard = true
                    },
                    block: {
                        pendingBlock = item
                        confirmingBlock = true
                    }
                )
                .cardRow(CardPosition(index: index, count: rows.count))
            }
        }
        PagedRowsEnd(
            moreFailed: pager.moreFailed, nextCursor: pager.nextCursor, loadingMore: pager.loadingMore,
            label: String(localized: "Loading more held items", bundle: .module),
            loadMore: { await pager.loadMore() }, retryMore: { await pager.retryMore() })
    }

    @ViewBuilder
    private var senderSection: some View {
        Text("Trusted contacts", bundle: .module).font(.headline).foregroundStyle(PsycheColor.text)
            .padding(.top, 28).padding(.bottom, 4)
            .task { await model.loadSenders() }
        Text("People whose facts Psyche accepts without asking. Sensitive or unsure facts still wait for you.",
             bundle: .module)
            .font(.subheadline).foregroundStyle(PsycheColor.muted).padding(.bottom, 12)
        switch model.senders {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 12)
        case .failed:
            FailedNotice { Task { await model.loadSenders() } }
        case .loaded(let rows) where rows.isEmpty:
            Text("No senders to review yet.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        case .loaded(let rows):
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, sender in
                SenderRowView(sender: sender) { decision in Task { await model.decide(sender, decision) } }
                    .cardRow(CardPosition(index: index, count: rows.count))
            }
        }
    }
}

/// One held item: the reasons in the Mac's words, where it came from, its text verbatim, and the owner's actions.
private struct HeldItemRow: View {
    let item: HeldItem
    let release: () -> Void
    let discard: () -> Void
    let block: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: item.reasons.map(reasonLabel).joined(separator: " · "))
                .font(.psycheRow).foregroundStyle(PsycheColor.text)
            Text(verbatim: String(
                format: String(localized: "From %1$@, %2$@", bundle: .module), item.source, shortDate(item.createdAt)))
                .font(.caption).foregroundStyle(PsycheColor.muted)
            Text("Text from the item (not shown as formatted):", bundle: .module)
                .font(.caption).foregroundStyle(PsycheColor.muted)
            Text(verbatim: item.excerpt)
                .font(.system(.callout, design: .monospaced)).foregroundStyle(PsycheColor.muted)
            HStack(spacing: 12) {
                Button(action: release) {
                    Text("Release", bundle: .module)
                }
                .buttonStyle(.psycheOutline)
                .accessibilityHint(Text("Read it once more; anything found still waits for your review.", bundle: .module))
                Button(action: discard) {
                    Text("Discard", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                }
                .buttonStyle(.plain)
                if item.senderEntityID != nil {
                    Button(action: block) {
                        Text("Block sender", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One sender: the offer to accept what they say about themselves, or the trusted contact with Stop.
private struct SenderRowView: View {
    let sender: SenderTrustRow
    let decide: (SenderDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if sender.state == .offered {
                Text(verbatim: String(
                    format: String(localized: "You confirmed %1$lld things %2$@ told you about themselves and discarded none. Accept what %2$@ says about themselves (birthday, job, city, school, likes, pets, children) without asking?",
                                   bundle: .module),
                    sender.confirmed, sender.name))
                    .font(.psycheRow).foregroundStyle(PsycheColor.text)
                Text("Anything sensitive, unsure or in conflict is still reviewed, and you can undo for a week.",
                     bundle: .module)
                    .font(.caption).foregroundStyle(PsycheColor.muted)
                HStack(spacing: 12) {
                    Button(action: { decide(.trust) }) {
                        Text("Accept automatically", bundle: .module)
                    }
                    .buttonStyle(.psycheOutline)
                    Button(action: { decide(.decline) }) {
                        Text("Not now, don't ask again", bundle: .module).font(.subheadline)
                            .foregroundStyle(PsycheColor.muted)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                HStack(spacing: 12) {
                    Text(verbatim: String(
                        format: String(localized: "%@: accepted automatically", bundle: .module), sender.name))
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                    Spacer(minLength: 0)
                    Button(action: { decide(.revoke) }) {
                        Text("Stop", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
