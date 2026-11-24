import Observation
import PsycheStore

// The rules behind the people actions and the memory pause. Pure where it can be, so the tests need no view.

/// Where the phone goes after a merge: the Gateway names the surviving person. If that is the page the owner merged
/// from, it stays; otherwise that page is replaced by the survivor, so Back doesn't land on a person who is gone.
public enum PersonMergeNavigation: Equatable {
    case stay
    case replace(with: String)

    public static func decide(current: String, survivor: String) -> PersonMergeNavigation {
        let next = survivor.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty, next != current else { return .stay }
        return .replace(with: next)
    }
}

/// A split is allowed when the person holds at least two contact details, the owner picked some but not all of
/// them, and the new person has a name. Mirrors the Mac's split dialog.
public enum PersonSplitRules {
    public static func canSplit(held: [EntityIdentifier]?, picked: Set<EntityIdentifier>, name: String, saving: Bool) -> Bool {
        guard let held, held.count >= 2, !saving else { return false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !picked.isEmpty && picked.count < held.count && !trimmed.isEmpty
    }
}

/// The memory capture switch on the Memory tab (memory.status for the state, memory.pause to change it).
@MainActor @Observable
final class MemoryPauseModel {
    /// Nil until the first read, so the row shows no button rather than a wrong one.
    private(set) var paused: Bool?
    var notice: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        do {
            paused = try await store.memoryPaused()
        } catch {
            paused = nil
        }
    }

    func toggle() async {
        guard let current = paused else { return }
        do {
            paused = try await store.setMemoryPaused(!current)
        } catch {
            notice = error.localizedDescription
        }
    }
}
