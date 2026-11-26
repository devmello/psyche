import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Memory (docs/design/ios-app-2026.md §4.5): To-do, Work and People. A native `List` with a large title and
/// `.searchable`; the owner's own content comes first. Pause, the Learning pages and the memory files are in the
/// toolbar menu.
struct MemoryView: View {
    private let motion = MotionContext()
    enum Segment: String, CaseIterable, Identifiable {
        case todo = "To-do", work = "Work", people = "People"
        var id: String { rawValue }
    }

    @State private var model: MemoryModel
    @State private var segment: Segment = .todo
    @State private var learning: LearningModel
    @State private var remembering = false
    @State private var addingPerson = false
    @State private var pauseModel: MemoryPauseModel
    private let store: any PsycheBackend
    @Environment(Session.self) private var session
    @Environment(Router.self) private var router

    init(store: any PsycheBackend) {
        _model = State(initialValue: MemoryModel(store: store))
        _learning = State(initialValue: LearningModel(store: store))
        _pauseModel = State(initialValue: MemoryPauseModel(store: store))
        self.store = store
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
            .navigationTitle(String(localized: "Memory", bundle: .module))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.large)
            #endif
            .searchable(text: $model.query, prompt: String(localized: "Search \(segment.rawValue.lowercased())", bundle: .module))
            .autocorrectionDisabled()
            .toolbar { ToolbarItem(placement: .primaryAction) { moreMenu } }
            .refreshable { await model.load() }
            .task {
                await model.load()
                await model.observe()
            }
            .task { await pauseModel.load() }
            .task(id: router.memoryFocusTodo) { await focusTodo(proxy) }
            .sensoryFeedback(.success, trigger: model.completions)
            .sheet(isPresented: $remembering) { RememberSheet(learning: learning) }
            .sheet(isPresented: $addingPerson) {
                AddPersonSheet(store: store) { id in
                    router.memoryPath.append(.person(id: id))
                    Task { await model.load() }
                }
            }
            .alert(String(localized: "Couldn't update that", bundle: .module), isPresented: noticeBinding) {
                Button(String(localized: "OK", bundle: .module), role: .cancel) {}
            } message: {
                Text(model.notice ?? "")
            }
            .alert(String(localized: "Couldn't change that", bundle: .module), isPresented: Binding(get: { pauseModel.notice != nil }, set: { if !$0 { pauseModel.notice = nil } })) {
                Button(String(localized: "OK", bundle: .module), role: .cancel) {}
            } message: {
                Text(pauseModel.notice ?? "")
            }
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
    }

    // MARK: Header

    /// The owner's own content comes first: the segment picker, then (only when they matter) a paused note and the
    /// claims waiting to be confirmed. Pause, Learning and Memory files live in the toolbar menu.
    @ViewBuilder
    private var header: some View {
        if session.state.showsBanner {
            ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                .listRowBackground(Color.clear)
        }
        // The picker and each note get their own section, so "To confirm" is a full rounded row with space
        // above it instead of a clipped row glued under the picker.
        Section {
            Picker(String(localized: "Memory", bundle: .module), selection: $segment) {
                ForEach(Segment.allCases) { Text(LocalizedStringKey($0.rawValue), bundle: .module).tag($0) }
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
        if pauseModel.paused == true {
            Section { pausedRow }
        }
        if model.claimCount > 0 {
            Section {
                Button { router.memoryPath.append(.claims) } label: {
                    LabeledContent {
                        Text(verbatim: "\(model.claimCount)")
                    } label: {
                        Text("To confirm", bundle: .module)
                    }
                }
                .tint(.primary)
                .accessibilityIdentifier("memoryToConfirmRow")
            }
        }
    }

    /// Memory capture paused: says so, and offers the one control that changes it (memory.pause). The same switch
    /// is in the toolbar menu when capture is on; there are no durations.
    private var pausedRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text("Memory is paused", bundle: .module).font(.headline)
            } icon: {
                Image(systemName: "pause.circle")
            }
            Text("Nothing new is remembered from your chats.", bundle: .module)
                .font(.subheadline).foregroundStyle(.secondary)
            Button {
                Task { await pauseModel.toggle() }
            } label: {
                Text("Resume memory", bundle: .module)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("memoryCaptureToggle")
        }
        .padding(.vertical, 4)
    }

    /// Everything that used to sit above the content: pause, the Learning pages, Remember this and the memory files.
    private var moreMenu: some View {
        Menu {
            if let paused = pauseModel.paused, !paused {
                Button {
                    Task { await pauseModel.toggle() }
                } label: {
                    Label(String(localized: "Pause memory", bundle: .module), systemImage: "pause.circle")
                }
            }
            Section(String(localized: "Learning", bundle: .module)) {
                Button { router.memoryPath.append(.learning) } label: {
                    Label(String(localized: "What Psyche learned", bundle: .module), systemImage: "graduationcap")
                }
                Button { router.memoryPath.append(.claims) } label: {
                    Label(String(localized: "To confirm", bundle: .module), systemImage: "questionmark.circle")
                }
                Button { router.memoryPath.append(.recentChanges) } label: {
                    Label(String(localized: "Recent changes", bundle: .module), systemImage: "clock.arrow.circlepath")
                }
                Button { router.memoryPath.append(.reviewQueue) } label: {
                    Label(String(localized: "Held back", bundle: .module), systemImage: "tray")
                }
                Button { remembering = true } label: {
                    Label(String(localized: "Remember this", bundle: .module), systemImage: "plus.bubble")
                }
            }
            Button { router.memoryPath.append(.memoryFiles) } label: {
                Label(String(localized: "Memory files", bundle: .module), systemImage: "doc.text")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(String(localized: "More", bundle: .module))
        .accessibilityIdentifier("memoryMoreMenu")
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
            failed(message)
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
        ContentUnavailableView {
            Label(String(localized: "Couldn't load this", bundle: .module), systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                .buttonStyle(.bordered)
        }
        .listRowBackground(Color.clear)
    }

    private func emptyNote(_ text: String) -> some View {
        Text(text)
            .font(.subheadline).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowBackground(Color.clear)
    }

    /// A secondary line under a row title: a text style in the secondary colour, not a mono log line.
    private func metaLine(_ text: String) -> some View {
        Text(MemoryText.localizingTimes(text)).font(.caption).foregroundStyle(.secondary)
    }

    // MARK: To-do

    @ViewBuilder
    private func todoRows(_ snapshot: MemorySnapshot) -> some View {
        let week = model.todos(in: .thisWeek, of: snapshot)
        let later = model.todos(in: .later, of: snapshot)
        if week.isEmpty && later.isEmpty {
            emptyNote(model.isSearching ? String(localized: "No to-dos match \u{201C}\(model.query)\u{201D}.", bundle: .module) : String(localized: "Nothing on your to-do list.", bundle: .module))
        }
        if !week.isEmpty {
            Section(String(localized: "This week", bundle: .module)) {
                ForEach(week, id: \.id) { todoRow($0) }
            }
        }
        if !later.isEmpty {
            Section(String(localized: "Later", bundle: .module)) {
                ForEach(later, id: \.id) { todoRow($0) }
            }
        }
        // Empty sections aren't drawn (§4.1): no catch-up line means no section.
        if !model.isSearching, !snapshot.leftOff.text.isEmpty {
            Section(String(localized: "Where you left off", bundle: .module)) {
                leftOffCard(snapshot.leftOff)
            }
        }
    }

    private func todoRow(_ todo: TodoItem) -> some View {
        let done = model.isDone(todo)
        return HStack(spacing: 12) {
            Button { model.toggle(todo) } label: { CircleCheck(done: done).frame(width: 44, height: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .padding(.leading, -10)
                .accessibilityLabel(done ? "Mark \(todo.title) not done" : "Mark \(todo.title) done")
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title)
                    .font(.body)
                    .strikethrough(done)
                    .foregroundStyle(done ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                metaLine(MemoryModel.displayMeta(todo, done: done))
                if todo.needsYou && !done {
                    StatusDot(.needsYou, String(localized: "Needs you", bundle: .module), font: .caption)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .onTapGesture { if let thread = todo.threadID { router.openThread(thread) } }
        .accessibilityElement(children: .contain)
        .listRowBackground(model.highlighted == todo.id ? PsycheColor.inkText.opacity(0.10) : nil)
        .id(todo.id)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { model.toggle(todo) } label: {
                Label(done ? "Open" : "Done", systemImage: done ? "arrow.uturn.backward" : "checkmark")
            }
            .tint(PsycheColor.ink)
        }
        .swipeActions(edge: .trailing) {
            if let thread = todo.threadID {
                Button { router.openThread(thread) } label: { Label(String(localized: "Open thread", bundle: .module), systemImage: "bubble.left") }
                    .tint(.gray)
            }
        }
    }

    private func leftOffCard(_ leftOff: LeftOff) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(Text(leftOff.title).fontWeight(.semibold)) \(leftOff.text)", bundle: .module)
                .font(.body)
            metaLine("\(String(localized: "Because", bundle: .module)) \(leftOff.evidence.joined(separator: " \u{B7} "))")
        }
        .accessibilityElement(children: .combine)
    }

    private func focusTodo(_ proxy: ScrollViewProxy) async {
        guard let id = router.memoryFocusTodo else { return }
        segment = .todo
        model.query = ""
        // Wait for the rows to exist before scrolling to one.
        for _ in 0..<20 where model.phase.value == nil { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .milliseconds(150))
        withAnimation(motion.layout(.gentle)) { proxy.scrollTo(id, anchor: .center) }
        router.memoryFocusTodo = nil
        await model.highlight(id)
    }

    // MARK: Work

    @ViewBuilder
    private func workRows(_ snapshot: MemorySnapshot) -> some View {
        let projects = model.projects(of: snapshot)
        if projects.isEmpty {
            emptyNote(model.isSearching ? String(localized: "No projects match \u{201C}\(model.query)\u{201D}.", bundle: .module) : String(localized: "No projects yet. Tell Psyche what you're working on.", bundle: .module))
        } else {
            Section(String(localized: "Projects", bundle: .module)) {
                ForEach(projects, id: \.id) { project in
                    Button { router.memoryPath.append(.project(id: project.id)) } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(project.title).font(.body).foregroundStyle(.primary)
                                ProgressView(value: min(max(project.fraction, 0), 1))
                                    .accessibilityHidden(true)
                                metaLine(project.detail)
                            }
                            chevron
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .task { await model.ensureProgress(project.id) }
                }
            }
        }
    }

    // MARK: People

    @ViewBuilder
    private func peopleRows(_ snapshot: MemorySnapshot) -> some View {
        let people = model.people(of: snapshot)
        if people.isEmpty {
            emptyNote(model.isSearching ? String(localized: "No one matches \u{201C}\(model.query)\u{201D}.", bundle: .module) : String(localized: "No people yet.", bundle: .module))
        } else {
            Section(String(localized: "People", bundle: .module)) {
                ForEach(people, id: \.id) { person in
                    Button { router.memoryPath.append(.person(id: person.id)) } label: {
                        HStack(spacing: 12) {
                            InitialsAvatar(person.initials)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(person.name).font(.body).foregroundStyle(.primary)
                                metaLine(person.detail)
                            }
                            Spacer(minLength: 0)
                            chevron
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        Section {
            Button { addingPerson = true } label: {
                Label(String(localized: "Add person", bundle: .module), systemImage: "person.badge.plus")
            }
            .accessibilityIdentifier("addPersonRow")
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

extension ConnectionState {
    /// The banner has something to say: still connecting, or unreachable.
    fileprivate var showsBanner: Bool {
        switch self {
        case .connecting, .unreachable: true
        default: false
        }
    }
}
