import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

@MainActor @Observable
final class SkillsModel {
    private(set) var phase: LoadPhase<[SkillItem]> = .idle
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    /// Reloads when a skill changes on the Mac and after a resync, until the view goes away.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.skills), .resynced: await load()
            default: break
            }
        }
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.skills())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }
}

/// Settings → Skills (read-only): each skill's name, what it does and whether it is on. Turning a skill on
/// or off, installing and removing are admin settings, so they stay on the Mac.
struct SkillsView: View {
    @State private var model: SkillsModel

    init(store: any PsycheBackend) {
        _model = State(initialValue: SkillsModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                switch model.phase {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                case .loaded(let skills):
                    if skills.isEmpty {
                        Text("No skills yet.", bundle: .module)
                            .font(.subheadline).foregroundStyle(PsycheColor.muted)
                    } else {
                        PaperStack {
                            ForEach(Array(skills.enumerated()), id: \.element.id) { index, skill in
                                if index > 0 { HairlineDivider() }
                                row(skill)
                            }
                        }
                    }
                case .failed(let message):
                    VStack(spacing: 12) {
                        Text("Couldn't load this", bundle: .module).font(.headline)
                        Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                            .buttonStyle(.psycheOutline).frame(maxWidth: 220)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
                }

                EditOnMacNote(text: String(localized: "Turn skills on or off and add new ones on your Mac.", bundle: .module))
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .navigationTitle(String(localized: "Skills", bundle: .module))
        .psycheInlineTitle()
        .refreshable { await model.load() }
        .task {
            await model.load()
            await model.observe()
        }
    }

    private func row(_ skill: SkillItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(skill.name).font(.psycheRow).foregroundStyle(PsycheColor.text)
                Text(skill.description.isEmpty ? String(localized: "No description yet.", bundle: .module) : skill.description)
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Text(skill.enabled ? String(localized: "On", bundle: .module) : String(localized: "Off", bundle: .module))
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
