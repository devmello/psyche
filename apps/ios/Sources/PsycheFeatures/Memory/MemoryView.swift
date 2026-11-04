import Observation
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class MemoryModel {
    private(set) var phase: LoadPhase<MemorySnapshot> = .idle
    /// Local-only until the Outbox exists (I2): which to-dos were ticked on this phone.
    var ticked: Set<String> = []
    private let store: any SnapshotStore

    init(store: any SnapshotStore) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.memory())
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func resync() async { await load() }

    func isDone(_ todo: TodoItem) -> Bool { todo.done || ticked.contains(todo.id) }

    func toggle(_ todo: TodoItem) {
        guard !todo.done else { return }
        if ticked.contains(todo.id) { ticked.remove(todo.id) } else { ticked.insert(todo.id) }
    }
}

struct MemoryView: View {
    enum Segment: String, CaseIterable, Identifiable {
        case todo = "To-do", work = "Work", people = "People"
        var id: String { rawValue }
    }

    @State private var model: MemoryModel
    @State private var segment: Segment = .todo
    @Environment(Session.self) private var session

    init(store: any SnapshotStore) {
        _model = State(initialValue: MemoryModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader("Memory")
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                Picker("Memory", selection: $segment) {
                    ForEach(Segment.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { snapshot in
                    switch segment {
                    case .todo: todoSections(snapshot)
                    case .work: workSection(snapshot)
                    case .people: peopleSection(snapshot)
                    }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .psycheHidesNavigationBar()
        .task { await model.load() }
        .refreshable { await model.resync() }
    }

    @ViewBuilder
    private func todoSections(_ snapshot: MemorySnapshot) -> some View {
        todoSection("This week", snapshot.todos.filter { $0.bucket == .thisWeek })
        todoSection("Later", snapshot.todos.filter { $0.bucket == .later })
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Where you left off")
            PaperCard(padding: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(Text(snapshot.leftOff.title).fontWeight(.semibold)) \(snapshot.leftOff.text)")
                        .font(.psycheRow)
                        .foregroundStyle(PsycheColor.text)
                    EvidenceLine("Because", snapshot.leftOff.evidence)
                }
            }
        }
    }

    @ViewBuilder
    private func todoSection(_ title: String, _ todos: [TodoItem]) -> some View {
        if !todos.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title)
                PaperCard {
                    ForEach(Array(todos.enumerated()), id: \.element.id) { index, todo in
                        if index > 0 { HairlineDivider() }
                        todoRow(todo)
                    }
                }
            }
        }
    }

    private func todoRow(_ todo: TodoItem) -> some View {
        let done = model.isDone(todo)
        return HStack(spacing: 12) {
            Button { model.toggle(todo) } label: { CircleCheck(done: done) }
                .buttonStyle(.plain)
                .accessibilityLabel(done ? "Mark not done" : "Mark done")
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.psycheRow)
                    .strikethrough(done)
                    .foregroundStyle(done ? PsycheColor.muted : PsycheColor.text)
                EvidenceLine([todo.meta])
            }
            Spacer(minLength: 0)
            if todo.needsYou && !done { NeedsYouDot() }
        }
        .padding(PsycheMetrics.rowPadding)
        .sensoryFeedback(.selection, trigger: done)
    }

    @ViewBuilder
    private func workSection(_ snapshot: MemorySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Projects")
            PaperCard {
                ForEach(Array(snapshot.projects.enumerated()), id: \.element.id) { index, project in
                    if index > 0 { HairlineDivider() }
                    NavigationLink(value: Route.project(id: project.id)) {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(project.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                                    .foregroundStyle(PsycheColor.muted.opacity(0.7))
                            }
                            ProgressBar(fraction: project.fraction)
                            EvidenceLine([project.detail])
                        }
                        .padding(PsycheMetrics.rowPadding)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private func peopleSection(_ snapshot: MemorySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("People")
            PaperCard {
                ForEach(Array(snapshot.people.enumerated()), id: \.element.id) { index, person in
                    if index > 0 { HairlineDivider() }
                    NavigationLink(value: Route.person(id: person.id)) {
                        HStack(spacing: 12) {
                            InitialsAvatar(person.initials)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(person.name).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                EvidenceLine([person.detail])
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                                .foregroundStyle(PsycheColor.muted.opacity(0.7))
                        }
                        .padding(PsycheMetrics.rowPadding)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
