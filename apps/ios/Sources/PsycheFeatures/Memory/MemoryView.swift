import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Memory (docs/design/ios-app-2026.md §4.5): To-do, Work and People. One `List`, so a to-do row can
/// swipe; every row is drawn as a slice of a paper card (`cardRow`).
struct MemoryView: View {
    enum Segment: String, CaseIterable, Identifiable {
        case todo = "To-do", work = "Work", people = "People"
        var id: String { rawValue }
    }

    @State private var model: MemoryModel
    @State private var segment: Segment = .todo
    @Environment(Session.self) private var session
    @Environment(Router.self) private var router

    init(store: any PsycheBackend) {
        _model = State(initialValue: MemoryModel(store: store))
        #if DEBUG
        if let name = UserDefaults.standard.string(forKey: "psycheMemorySegment"),
            let start = Segment(rawValue: name)
        {
            _segment = State(initialValue: start)
        }
        #endif
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                header
                content
            }
            .memoryListStyle()
            .psycheHidesNavigationBar()
            .refreshable { await model.load() }
            .task {
                await model.load()
                await model.observe()
            }
            .task(id: router.memoryFocusTodo) { await focusTodo(proxy) }
            .sensoryFeedback(.success, trigger: model.completions)
            .alert("Couldn't update that", isPresented: noticeBinding) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.notice ?? "")
            }
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
    }

    // MARK: Header

    @ViewBuilder
    private var header: some View {
        PageHeader("Memory").plainRow(top: 8, bottom: 14)
        ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
            .plainRow(bottom: session.state.isUnreachable ? 14 : 0)
        Picker("Memory", selection: $segment) {
            ForEach(Segment.allCases) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        .plainRow(bottom: 12)
        PaperSearchField(prompt: "Search \(segment.rawValue.lowercased())", text: $model.query)
            .plainRow(bottom: 8)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            body(for: .skeleton)
                .redacted(reason: .placeholder)
                .allowsHitTesting(false)
        case .loaded(let snapshot):
            body(for: snapshot)
        case .failed(let message):
            failed(message).plainRow(top: 24)
        }
    }

    @ViewBuilder
    private func body(for snapshot: MemorySnapshot) -> some View {
        switch segment {
        case .todo: todoRows(snapshot)
        case .work: workRows(snapshot)
        case .people: peopleRows(snapshot)
        }
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 12) {
            Text("Couldn't load this").font(.headline).foregroundStyle(PsycheColor.text)
            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
            Button("Try again") { Task { await model.load() } }
                .buttonStyle(.psycheOutline)
                .frame(maxWidth: 220)
        }
        .frame(maxWidth: .infinity)
    }

    private func sectionHeader(_ title: String) -> some View {
        SectionHeader(title).plainRow(top: 14, bottom: 8)
    }

    private func emptyNote(_ text: String) -> some View {
        Text(text)
            .font(.subheadline).foregroundStyle(PsycheColor.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .plainRow(top: 8)
    }

    // MARK: To-do

    @ViewBuilder
    private func todoRows(_ snapshot: MemorySnapshot) -> some View {
        let week = model.todos(in: .thisWeek, of: snapshot)
        let later = model.todos(in: .later, of: snapshot)
        if week.isEmpty && later.isEmpty {
            emptyNote(model.isSearching ? "No to-dos match \u{201C}\(model.query)\u{201D}." : "Nothing on your to-do list.")
        }
        if !week.isEmpty {
            sectionHeader("This week")
            ForEach(Array(week.enumerated()), id: \.element.id) { index, todo in
                todoRow(todo, position: CardPosition(index: index, count: week.count))
            }
        }
        if !later.isEmpty {
            sectionHeader("Later")
            ForEach(Array(later.enumerated()), id: \.element.id) { index, todo in
                todoRow(todo, position: CardPosition(index: index, count: later.count))
            }
        }
        // Empty sections aren't drawn (§4.1): no catch-up line means no card.
        if !model.isSearching, !snapshot.leftOff.text.isEmpty {
            sectionHeader("Where you left off")
            leftOffCard(snapshot.leftOff)
        }
    }

    private func todoRow(_ todo: TodoItem, position: CardPosition) -> some View {
        let done = model.isDone(todo)
        return HStack(spacing: 12) {
            Button { model.toggle(todo) } label: { CircleCheck(done: done).frame(width: 44, height: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .padding(.leading, -10)
                .accessibilityLabel(done ? "Mark \(todo.title) not done" : "Mark \(todo.title) done")
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.psycheRow)
                    .strikethrough(done)
                    .foregroundStyle(done ? PsycheColor.muted : PsycheColor.text)
                    .multilineTextAlignment(.leading)
                EvidenceLine([MemoryModel.displayMeta(todo, done: done)])
            }
            Spacer(minLength: 0)
            if todo.needsYou && !done { NeedsYouDot() }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, PsycheMetrics.rowPadding.leading)
        .contentShape(Rectangle())
        .onTapGesture { if let thread = todo.threadID { router.openThread(thread) } }
        .accessibilityElement(children: .contain)
        .cardRow(position, highlighted: model.highlighted == todo.id)
        .id(todo.id)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { model.toggle(todo) } label: {
                Label(done ? "Open" : "Done", systemImage: done ? "arrow.uturn.backward" : "checkmark")
            }
            .tint(PsycheColor.ink)
        }
        .swipeActions(edge: .trailing) {
            if let thread = todo.threadID {
                Button { router.openThread(thread) } label: { Label("Open thread", systemImage: "bubble.left") }
                    .tint(PsycheColor.muted)
            }
        }
    }

    private func leftOffCard(_ leftOff: LeftOff) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(Text(leftOff.title).fontWeight(.semibold)) \(leftOff.text)")
                .font(.psycheRow)
                .foregroundStyle(PsycheColor.text)
            EvidenceLine("Because", leftOff.evidence)
        }
        .padding(14)
        .cardRow(.only)
        .accessibilityElement(children: .combine)
    }

    private func focusTodo(_ proxy: ScrollViewProxy) async {
        guard let id = router.memoryFocusTodo else { return }
        segment = .todo
        model.query = ""
        // Wait for the rows to exist before scrolling to one.
        for _ in 0..<20 where model.phase.value == nil { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .milliseconds(150))
        withAnimation { proxy.scrollTo(id, anchor: .center) }
        router.memoryFocusTodo = nil
        await model.highlight(id)
    }

    // MARK: Work

    @ViewBuilder
    private func workRows(_ snapshot: MemorySnapshot) -> some View {
        let projects = model.projects(of: snapshot)
        if projects.isEmpty {
            emptyNote(model.isSearching ? "No projects match \u{201C}\(model.query)\u{201D}." : "No projects yet. Tell Psyche what you're working on.")
        } else {
            sectionHeader("Projects")
            ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
                Button { router.memoryPath.append(.project(id: project.id)) } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(project.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            Spacer(minLength: 0)
                            chevron
                        }
                        ProgressBar(fraction: project.fraction)
                        EvidenceLine([project.detail])
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .cardRow(CardPosition(index: index, count: projects.count))
            }
        }
    }

    // MARK: People

    @ViewBuilder
    private func peopleRows(_ snapshot: MemorySnapshot) -> some View {
        let people = model.people(of: snapshot)
        if people.isEmpty {
            emptyNote(model.isSearching ? "No one matches \u{201C}\(model.query)\u{201D}." : "No people yet.")
        } else {
            sectionHeader("People")
            ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                Button { router.memoryPath.append(.person(id: person.id)) } label: {
                    HStack(spacing: 12) {
                        InitialsAvatar(person.initials)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(person.name).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            EvidenceLine([person.detail])
                        }
                        Spacer(minLength: 0)
                        chevron
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .cardRow(CardPosition(index: index, count: people.count))
            }
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
            .foregroundStyle(PsycheColor.muted.opacity(0.7))
            .accessibilityHidden(true)
    }
}

extension ConnectionState {
    fileprivate var isUnreachable: Bool {
        if case .unreachable = self { true } else { false }
    }
}
