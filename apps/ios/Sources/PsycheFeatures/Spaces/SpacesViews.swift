import PsycheBlocks
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Words for the Spaces screens, all from the catalog in `Resources/Localizable.xcstrings`.
enum SpacesText {
    /// "Updated 10 min ago", or nothing when the tracker has never refreshed.
    static func updated(_ date: Date?) -> String? {
        guard let date else { return nil }
        let ago = date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        return String(localized: "Updated \(ago)", bundle: .module)
    }

    /// The line under a tracker: when it refreshed and whether it can be trusted to be current.
    static func trackerLine(_ tracker: SpaceTrackerItem, _ status: SpaceTrackerStatus?) -> [String] {
        var parts: [String] = []
        if let updated = updated(status?.refreshedAt ?? tracker.refreshedAt) { parts.append(updated) }
        if status?.unavailable == true {
            parts.append(String(localized: "Source unavailable", bundle: .module))
        } else if status?.stale == true {
            parts.append(String(localized: "Out of date", bundle: .module))
        }
        return parts
    }

    static func folderMode(_ folder: SpaceFolderItem) -> String {
        folder.writable
            ? String(localized: "Read and write", bundle: .module) : String(localized: "Read only", bundle: .module)
    }
}

// MARK: Home section

/// Home's Spaces section, after Pinned: one row per Space. Not drawn while there are none or the load failed.
struct SpacesHomeSection: View {
    @State private var model: SpacesListModel
    @Environment(Router.self) private var router

    init(store: any PsycheBackend) { _model = State(initialValue: SpacesListModel(store: store)) }

    var body: some View {
        Group {
            if !model.spaces.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(String(localized: "Spaces", bundle: .module), count: model.spaces.count)
                    PaperCard {
                        ForEach(Array(model.spaces.prefix(6).enumerated()), id: \.element.id) { index, space in
                            if index > 0 { HairlineDivider() }
                            Button { router.homePath.append(.space(id: space.id)) } label: { row(space) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .task {
            await model.load()
            await model.observe()
        }
    }

    private func row(_ space: SpaceItem) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(space.name).font(.psycheRow).foregroundStyle(PsycheColor.text).lineLimit(1)
                if !space.description.isEmpty { EvidenceLine([space.description]) }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(PsycheColor.muted.opacity(0.7))
                .accessibilityHidden(true)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

// MARK: Space page

/// One Space: trackers on top, then Chats, Work due, Automations, and Files and links (read only here). Folders and
/// Space settings are shown with "Change on your Mac"; the instructions can be edited from the phone.
struct SpaceView: View {
    @State private var model: SpaceModel
    @State private var editing = false
    @Environment(Session.self) private var session
    @Environment(Router.self) private var router
    private let store: any PsycheBackend

    init(id: String, store: any PsycheBackend) {
        self.store = store
        _model = State(initialValue: SpaceModel(id: id, store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                switch model.phase {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                case .failed(let message):
                    VStack(spacing: 12) {
                        Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                            .font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.inkText)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
                case .loaded(let detail):
                    loaded(detail)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .navigationTitle(model.phase.value?.space.name ?? "")
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { if let chat = await model.newChat() { router.openThread(chat) } }
                } label: {
                    Label(String(localized: "New chat here", bundle: .module), systemImage: "square.and.pencil")
                }
                .disabled(model.phase.value == nil || !session.state.canAnswer)
            }
        }
        .task {
            await model.load(opening: true)
            await model.observe()
        }
        .refreshable { await model.load() }
        .sheet(isPresented: $editing) {
            if let detail = model.phase.value {
                InstructionsEditor(text: detail.instructions) { text in await model.saveInstructions(text) }
            }
        }
        .alert(String(localized: "Couldn't do that", bundle: .module), isPresented: errorShown) {
            Button(String(localized: "OK", bundle: .module)) { model.clearError() }
        } message: {
            Text(model.actionError ?? "")
        }
    }

    private var errorShown: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.clearError() } })
    }

    @ViewBuilder
    private func loaded(_ detail: SpaceDetailItem) -> some View {
        if !detail.space.description.isEmpty {
            Text(detail.space.description).font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
        if !detail.trackers.isEmpty { trackers(detail.trackers) }
        instructions(detail.instructions)
        if !model.chats.isEmpty { chats(model.chats) }
        if detail.space.due > 0 || detail.automations > 0 { work(detail) }
        if !detail.folders.isEmpty || !detail.links.isEmpty { files(detail) }
    }

    private func trackers(_ items: [SpaceTrackerItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Trackers", bundle: .module), count: items.count)
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(items) { tracker in
                    VStack(alignment: .leading, spacing: 6) {
                        if let snapshot = model.widgets[tracker.widgetID] {
                            WidgetView(snapshot: snapshot, backend: store, surface: .overview)
                        }
                        HStack {
                            let line = SpacesText.trackerLine(tracker, model.status[tracker.widgetID])
                            if !line.isEmpty { EvidenceLine(line) }
                            Spacer(minLength: 0)
                            if tracker.canRefresh {
                                Button(String(localized: "Refresh", bundle: .module)) { Task { await model.refresh(tracker) } }
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(PsycheColor.inkText)
                                    .buttonStyle(.plain)
                                    .disabled(model.refreshing.contains(tracker.widgetID) || !session.state.canAnswer)
                            }
                        }
                        .padding(.horizontal, 4)
                    }
                }
            }
        }
    }

    private func instructions(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionHeader(String(localized: "Instructions", bundle: .module))
                Spacer(minLength: 0)
                Button(String(localized: "Edit", bundle: .module)) { editing = true }
                    .font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.muted).buttonStyle(.plain)
                    .disabled(!session.state.canAnswer)
            }
            PaperCard {
                Text(text.isEmpty ? String(localized: "No instructions yet.", bundle: .module) : text)
                    .font(.psycheRow)
                    .foregroundStyle(text.isEmpty ? PsycheColor.muted : PsycheColor.text)
                    .padding(PsycheMetrics.rowPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func chats(_ chats: [ChatThreadSummary]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Chats", bundle: .module), count: chats.count)
            PaperCard {
                ForEach(Array(chats.enumerated()), id: \.element.id) { index, chat in
                    if index > 0 { HairlineDivider() }
                    Button { router.openThread(chat.id) } label: {
                        HStack {
                            Text(chat.title).font(.psycheRow).foregroundStyle(PsycheColor.text).lineLimit(1)
                            Spacer(minLength: 0)
                            Text(chat.updated).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                        }
                        .padding(PsycheMetrics.rowPadding)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func work(_ detail: SpaceDetailItem) -> some View {
        PaperCard {
            if detail.space.due > 0 {
                countRow(String(localized: "Work due", bundle: .module), detail.space.due)
            }
            if detail.space.due > 0 && detail.automations > 0 { HairlineDivider() }
            if detail.automations > 0 {
                countRow(String(localized: "Automations", bundle: .module), detail.automations)
            }
        }
    }

    private func countRow(_ title: String, _ count: Int) -> some View {
        HStack {
            Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text)
            Spacer(minLength: 0)
            Text("\(count)").font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
        }
        .padding(PsycheMetrics.rowPadding)
        .accessibilityElement(children: .combine)
    }

    private func files(_ detail: SpaceDetailItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Files and links", bundle: .module))
            PaperCard {
                ForEach(Array(detail.folders.enumerated()), id: \.element.id) { index, folder in
                    if index > 0 { HairlineDivider() }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(folder.path).font(.psycheRow).foregroundStyle(PsycheColor.text).lineLimit(1).truncationMode(.middle)
                        EvidenceLine([SpacesText.folderMode(folder)])
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !detail.folders.isEmpty && !detail.links.isEmpty { HairlineDivider() }
                ForEach(Array(detail.links.enumerated()), id: \.element.id) { index, link in
                    if index > 0 { HairlineDivider() }
                    VStack(alignment: .leading, spacing: 3) {
                        // A link's label is text, never a control: an untrusted one came from outside the owner.
                        Text(verbatim: link.label).font(.psycheRow).foregroundStyle(PsycheColor.text).lineLimit(2)
                        if link.untrusted { EvidenceLine([String(localized: "From an outside source", bundle: .module)]) }
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if !detail.folders.isEmpty {
                Text("Change folders and settings on your Mac.", bundle: .module)
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
    }
}

// MARK: Instructions editor

private struct InstructionsEditor: View {
    @State var text: String
    let save: (String) async -> Bool
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    private static let limit = 4000

    init(text: String, save: @escaping (String) async -> Bool) {
        _text = State(initialValue: text)
        self.save = save
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $text)
                    .font(.psycheRow)
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
                    .onChange(of: text) { _, new in if new.count > Self.limit { text = String(new.prefix(Self.limit)) } }
                Text("Changes apply from the next message.", bundle: .module)
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
            }
            .padding(PsycheMetrics.pagePadding)
            .psycheScreen()
            .navigationTitle(String(localized: "Instructions", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save", bundle: .module)) {
                        saving = true
                        Task {
                            if await save(text) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(saving)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
