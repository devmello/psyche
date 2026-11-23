import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

// The Soul & Memory files on the phone (`/agent/soul`, `/agent/soul?file=…`, `/agent/soul?entity=…`). Read-only:
// the files are edited on the Mac. Reached from the Memory tab's People list and from source chips.

@MainActor @Observable
final class MemoryFilesModel {
    private(set) var phase: LoadPhase<[MemoryFileRow]> = .idle
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.memoryFiles())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }
}

@MainActor @Observable
final class MemoryFileModel {
    private(set) var phase: LoadPhase<MemoryFileContent> = .idle
    private let path: String
    private let store: any PsycheBackend

    init(path: String, store: any PsycheBackend) {
        self.path = path
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.memoryFile(path: path))
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }
}

/// The list of workspace files. Each row pushes `Route.memoryFile(path:)` onto the same stack.
struct MemoryFilesView: View {
    @State private var model: MemoryFilesModel

    init(store: any PsycheBackend) {
        _model = State(initialValue: MemoryFilesModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Memory files", bundle: .module).psycheTitle().padding(.bottom, 4)
                Text("The notes and files your agent keeps. Read-only on the phone.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted).padding(.bottom, 16)
                content
            }
            .padding(PsycheMetrics.pagePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
        case .failed(let message):
            RetryNotice(message: message) { Task { await model.load() } }
        case .loaded(let files) where files.isEmpty:
            Text("No memory files yet.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
        case .loaded(let files):
            ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                NavigationLink(value: Route.memoryFile(path: file.path)) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: file.path).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            Text(verbatim: ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file))
                                .font(.caption).foregroundStyle(PsycheColor.muted)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .cardRow(CardPosition(index: index, count: files.count))
            }
        }
    }
}

/// One workspace file, as plain text: scrollable and selectable, never interpreted as markup.
struct MemoryFileView: View {
    let path: String
    @State private var model: MemoryFileModel

    init(path: String, store: any PsycheBackend) {
        self.path = path
        _model = State(initialValue: MemoryFileModel(path: path, store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: path).font(.headline.monospaced()).foregroundStyle(PsycheColor.text).textSelection(.enabled)
                switch model.phase {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
                case .failed(let message):
                    RetryNotice(message: message) { Task { await model.load() } }
                case .loaded(let file) where file.content.isEmpty:
                    Text("This file is empty.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                case .loaded(let file):
                    Text(verbatim: file.content)
                        .font(.body)
                        .foregroundStyle(PsycheColor.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("Read-mostly on the phone. Edit on your Mac.", bundle: .module)
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
            }
            .padding(PsycheMetrics.pagePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .task { await model.load() }
    }
}

/// What an entity's kind opens on the phone. People and organisations share the person page; projects get the
/// project page. Anything else (a place, an event, a topic, an assignment) is for the Mac.
enum EntityPage: Equatable {
    case person, project, other

    static func page(for kind: String) -> EntityPage {
        switch kind {
        case "person", "org": .person
        case "project": .project
        default: .other
        }
    }
}

/// `/agent/soul?entity=<id>`: resolves the entity's kind (memory.entities.get), then shows its page. A failed lookup
/// shows the error with a retry.
struct EntityRouteView: View {
    let id: String
    let store: any PsycheBackend
    @State private var phase: LoadPhase<String> = .idle

    var body: some View {
        Group {
            switch phase {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ScrollView {
                    RetryNotice(message: message) { Task { await load() } }
                        .padding(PsycheMetrics.pagePadding)
                }
            case .loaded(let kind):
                switch EntityPage.page(for: kind) {
                case .person: PersonPage(id: id, store: store)
                case .project: ProjectPage(id: id, store: store)
                case .other:
                    ScrollView {
                        Text("This one is not a person or project. The phone shows people and projects; open it on your Mac.", bundle: .module)
                            .font(.subheadline).foregroundStyle(PsycheColor.muted)
                            .padding(PsycheMetrics.pagePadding)
                    }
                }
            }
        }
        .psycheScreen()
        .task { await load() }
    }

    private func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.entityKind(id: id))
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }
}

/// A failed load, with the Gateway's words and a retry.
private struct RetryNotice: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Couldn't load this", bundle: .module).font(.headline).foregroundStyle(PsycheColor.text)
            Text(verbatim: message).font(.subheadline).foregroundStyle(PsycheColor.muted)
            Button(action: retry) { Text("Try again", bundle: .module) }
                .buttonStyle(.psycheOutline)
                .frame(maxWidth: 220)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
