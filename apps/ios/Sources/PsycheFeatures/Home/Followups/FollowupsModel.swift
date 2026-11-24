import Foundation
import Observation
import PsycheStore

/// Home's follow-ups and suggestions. Each action takes its row off the list at once, then refetches what the Gateway
/// holds, so what is on screen is what the Gateway now says. A refusal shows the Gateway's words and keeps the list.
@MainActor @Observable
final class FollowupsModel {
    /// How long Undo stays on an approved suggestion (the Gateway's undo window).
    static let undoWindow: TimeInterval = 30

    private(set) var followups: [MailFollowup] = []
    private(set) var suggestions: [Suggestion] = []
    /// Approved suggestions that can still be undone, with the moment the window closes.
    private(set) var undoable: [UndoWindow] = []
    /// The latest refusal or failure, shown quietly under the sections.
    private(set) var error: String?
    /// Ids with a call in flight: their buttons wait.
    private(set) var busy: Set<String> = []
    private let store: any PsycheBackend

    struct UndoWindow: Equatable, Identifiable {
        var suggestion: Suggestion
        var until: Date
        var id: String { suggestion.id }
    }

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        // A failed read keeps what is on screen: the sections are optional, so a Gateway without mail or proposals
        // shows nothing rather than an error.
        if let items = try? await store.mailFollowups() { followups = items }
        if let items = try? await store.suggestions() { suggestions = items }
    }

    /// Refetches when Home's data changed or the connection resynced, until the view goes away.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home), .resynced: await load()
            default: break
            }
        }
    }

    func act(on item: MailFollowup, _ action: MailFollowupAction) async {
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id)
        defer { busy.remove(item.id) }
        followups.removeAll { $0.id == item.id }
        do {
            try await store.actOnMailFollowup(id: item.id, action: action)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }

    /// Approve, from the detail sheet where the calls are on screen. The Gateway requests the batch approval and answers
    /// it with this phone's token. Returns the Needs-you item to open in the approval sheet when the phone must not
    /// answer it itself (a payment); nil when it was answered here.
    @discardableResult
    func approve(_ suggestion: Suggestion) async -> NeedsYouItem? {
        guard !busy.contains(suggestion.id) else { return nil }
        busy.insert(suggestion.id)
        defer { busy.remove(suggestion.id) }
        var handoff: NeedsYouItem?
        do {
            handoff = try await store.approveSuggestion(id: suggestion.id)
            error = nil
            if handoff == nil {
                suggestions.removeAll { $0.id == suggestion.id }
                // Keep it for Undo when it ran and can be reversed; the Gateway says whether it did.
                if let ran = try? await store.suggestion(id: suggestion.id), ran.canUndo {
                    undoable.append(UndoWindow(suggestion: ran, until: .now.addingTimeInterval(Self.undoWindow)))
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
        await load()
        return handoff
    }

    func dismiss(_ suggestion: Suggestion) async {
        guard !busy.contains(suggestion.id) else { return }
        busy.insert(suggestion.id)
        defer { busy.remove(suggestion.id) }
        suggestions.removeAll { $0.id == suggestion.id }
        do {
            try await store.dismissSuggestion(id: suggestion.id)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }

    /// Offers the inverse; it comes back in the list as a suggestion waiting for its own approval.
    func undo(_ window: UndoWindow) async {
        guard !busy.contains(window.id) else { return }
        busy.insert(window.id)
        defer { busy.remove(window.id) }
        do {
            try await store.undoSuggestion(id: window.suggestion.id)
            error = nil
            undoable.removeAll { $0.id == window.id }
        } catch {
            self.error = error.localizedDescription
        }
        await load()
    }

    /// The approved suggestions whose Undo window is still open at `now`.
    func openUndo(at now: Date) -> [UndoWindow] {
        undoable.filter { $0.until > now }
    }
}
