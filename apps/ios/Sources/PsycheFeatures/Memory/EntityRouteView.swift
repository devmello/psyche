import PsycheDesign
import PsycheStore
import SwiftUI

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
