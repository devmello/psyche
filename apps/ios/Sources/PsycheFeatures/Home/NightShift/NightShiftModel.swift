import Foundation
import Observation
import PsycheStore

/// Home's "Prepared overnight" card: the counts, and the first few one-liners of the review waiting. Drawn only while a
/// review is waiting. A failed read keeps what is on screen; the card is optional, so a Gateway without Night shift
/// (or Night shift off) shows nothing rather than an error.
@MainActor @Observable
final class NightShiftCardModel {
    private(set) var status: NightShiftStatus?
    private(set) var firstLines: [String] = []
    private let store: any NightShiftBackend & LiveUpdates

    init(store: any NightShiftBackend & LiveUpdates) {
        self.store = store
    }

    /// The review to open, when there is one with something ready in it.
    var reviewID: String? {
        guard let status, status.enabled, status.counts.total > 0 else { return nil }
        return status.readyReviewID
    }

    func load() async {
        guard let status = try? await store.nightShiftStatus() else { return }
        self.status = status
        guard let id = status.readyReviewID, status.counts.total > 0 else {
            firstLines = []
            return
        }
        if let review = try? await store.nightShiftReview(id: id) {
            firstLines = review.items.filter(\.canTick).prefix(3).map(\.summary)
        }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home), .resynced: await load()
            default: break
            }
        }
    }
}

/// The review screen. It draws only what the Gateway sent for this review, as plain text, and answers only what the
/// owner ticked.
@MainActor @Observable
final class NightShiftReviewModel {
    enum Banner: Equatable {
        /// The approval was answered: the Gateway is running the ticked changes.
        case applying(Int)
        /// The approval can't be answered here (too large to read on the phone): it waits on the Mac.
        case needsMac
        /// The approval did not bind what was ticked. Nothing was answered.
        case mismatch
        /// A refusal or failure in the Gateway's words.
        case failure(String)
    }

    let reviewID: String
    private(set) var phase: LoadPhase<NightShiftReview> = .idle
    private(set) var selection = NightShiftSelection()
    private(set) var banner: Banner?
    private(set) var busy = false
    private let store: any NightShiftBackend & LiveUpdates

    init(reviewID: String, store: any NightShiftBackend & LiveUpdates) {
        self.reviewID = reviewID
        self.store = store
    }

    var items: [NightShiftItem] { phase.value?.items ?? [] }

    /// What the footer's Apply would send now.
    var pending: NightShiftApplyRequest { selection.request(reviewID: reviewID, items: items) }

    /// Items grouped by domain in the order the Mac lists them. Items that are done or gone are kept: a row shows
    /// applied, failed or uncertain after Apply.
    func group(_ domain: NightShiftDomain) -> [NightShiftItem] {
        items.filter { $0.domain == domain && $0.status != .dismissed && $0.status != .expired }
    }

    /// Ready items with no apply open for them: what Dismiss the rest may take.
    private var dismissible: [NightShiftItem] { items.filter { $0.status == .ready && !$0.applying } }
    var canDismissRest: Bool { !dismissible.isEmpty }

    /// The review's own expiry, as the Gateway holds it.
    var expiresAt: Date? { phase.value?.expiresAt }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            let review = try await store.nightShiftReview(id: reviewID)
            phase = .loaded(review)
            selection.reconcile(with: review.items)
        } catch {
            // A failed refresh keeps what is on screen.
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home), .resynced: await load()
            default: break
            }
        }
    }

    func toggle(_ item: NightShiftItem) { selection.toggle(item) }
    func toggleSend(_ item: NightShiftItem) { selection.toggleSend(item) }
    func expand(_ item: NightShiftItem) { selection.expand(item) }
    func selectAll() { selection.selectAll(items) }
    func clear() { selection.clear() }

    /// Apply selected. The backend checks the approval it gets back against exactly this request before it answers.
    func apply() async {
        let request = pending
        guard !busy, !request.isEmpty else { return }
        busy = true
        defer { busy = false }
        banner = nil
        do {
            switch try await store.applyNightShift(request) {
            case .answered(let refused):
                selection.markRefused(refused)
                banner = .applying(max(0, request.items.count - refused.count))
                selection.clear()
            case .needsMac(let refused):
                selection.markRefused(refused)
                banner = .needsMac
            case .nothingApproved(let refused):
                selection.markRefused(refused)
                banner = .failure(refused.first?.reason ?? "")
            }
        } catch NightShiftApplyError.mismatch {
            banner = .mismatch
        } catch {
            banner = .failure(error.localizedDescription)
        }
        await load()
    }

    /// Undo an applied item (within a day). The Gateway refuses it at run time if the target changed since.
    func undo(_ item: NightShiftItem) async {
        guard !busy, item.canUndo else { return }
        busy = true
        defer { busy = false }
        banner = nil
        do {
            switch try await store.undoNightShift(itemIDs: [item.id]) {
            case .answered(let refused): banner = refused.isEmpty ? .applying(1) : .failure(refused.first?.reason ?? "")
            case .needsMac: banner = .needsMac
            case .nothingApproved(let refused): banner = .failure(refused.first?.reason ?? "")
            }
        } catch NightShiftApplyError.mismatch {
            banner = .mismatch
        } catch {
            banner = .failure(error.localizedDescription)
        }
        await load()
    }

    /// Dismiss the rest: every item still ready. Runs nothing.
    func dismissRest() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        banner = nil
        do {
            try await store.dismissNightShift(reviewID: reviewID, itemIDs: dismissible.map(\.id))
            selection.clear()
        } catch {
            banner = .failure(error.localizedDescription)
        }
        await load()
    }
}
