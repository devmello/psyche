import Foundation
import Observation
import PsycheStore

@MainActor @Observable
final class MemoryModel {
    private(set) var phase: LoadPhase<MemorySnapshot> = .idle
    /// Optimistic to-do state, by id, for ticks the Gateway has not confirmed yet.
    private(set) var overrides: [String: Bool] = [:]
    /// Bumped on each check-off, so the view can play one haptic.
    private(set) var completions = 0
    /// Shown in an alert when a write fails.
    var notice: String?
    /// "Search within Memory": filters the visible segment.
    var query = ""
    /// A to-do to flash after Search opened it.
    private(set) var highlighted: String?

    private var pending: Set<String> = []
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.memory())
            overrides = overrides.filter { pending.contains($0.key) }
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    /// Refetches when Memory changed or the connection resynced, until the view goes away.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.memory), .resynced: await load()
            default: break
            }
        }
    }

    func isDone(_ todo: TodoItem) -> Bool { overrides[todo.id] ?? todo.done }

    func toggle(_ todo: TodoItem) {
        let target = !isDone(todo)
        overrides[todo.id] = target
        pending.insert(todo.id)
        if target { completions += 1 }
        Task {
            do {
                try await store.setTodo(id: todo.id, done: target)
            } catch {
                overrides[todo.id] = nil
                notice = error.localizedDescription
            }
            pending.remove(todo.id)
        }
    }

    /// Flashes a row for a moment (the target of a Search hit).
    func highlight(_ id: String) async {
        highlighted = id
        try? await Task.sleep(for: .seconds(1.6))
        if highlighted == id { highlighted = nil }
    }

    // MARK: Filtering

    var isSearching: Bool { !trimmedQuery.isEmpty }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func matches(_ parts: String...) -> Bool {
        guard isSearching else { return true }
        return parts.contains { $0.localizedCaseInsensitiveContains(trimmedQuery) }
    }

    func todos(in bucket: TodoItem.Bucket, of snapshot: MemorySnapshot) -> [TodoItem] {
        snapshot.todos.filter { $0.bucket == bucket && matches($0.title, $0.meta) }
    }

    func projects(of snapshot: MemorySnapshot) -> [ProjectItem] {
        snapshot.projects.filter { matches($0.title, $0.detail) }
    }

    func people(of snapshot: MemorySnapshot) -> [PersonItem] {
        snapshot.people.filter { matches($0.name, $0.detail) }
    }

    /// "Handed in · Oct 31" for a to-do just ticked here; the original line again if it is unticked.
    static func displayMeta(_ todo: TodoItem, done: Bool) -> String {
        let prefix = "Handed in"
        if done && !todo.meta.hasPrefix(prefix) { return "\(prefix) · \(todo.meta)" }
        if !done && todo.meta.hasPrefix(prefix) {
            return todo.meta.components(separatedBy: " · ").dropFirst().joined(separator: " · ")
        }
        return todo.meta
    }
}
