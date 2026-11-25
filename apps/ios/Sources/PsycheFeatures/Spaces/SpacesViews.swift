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

    /// The Mac's template names (`spaces.template.*`).
    static func templateName(_ template: SpaceTrackerTemplateItem) -> String {
        switch template {
        case .workDue: String(localized: "Work due", bundle: .module)
        case .nextEvents: String(localized: "Next events", bundle: .module)
        case .recentFiles: String(localized: "Recent files", bundle: .module)
        case .mailOnThis: String(localized: "Mail on this", bundle: .module)
        case .checklist: String(localized: "Checklist", bundle: .module)
        case .automationStatus: String(localized: "Automation status", bundle: .module)
        }
    }

    static var untrustedSuggestion: String {
        String(localized: "Suggested while reading outside content. Check it before you create it.", bundle: .module)
    }
}

// MARK: Home section

/// Home's Spaces page, behind More: one row per Space, then a quiet "Suggested" group and the archived Spaces.
struct SpacesHomeSection: View {
    @State private var model: SpacesListModel
    @Environment(Router.self) private var router

    init(store: any PsycheBackend) { _model = State(initialValue: SpacesListModel(store: store)) }

    var body: some View {
        List {
            if model.spaces.isEmpty && model.proposals.isEmpty && model.archived.isEmpty {
                ContentUnavailableView(String(localized: "No Spaces yet", bundle: .module), systemImage: "square.stack")
                    .listRowBackground(Color.clear)
            }
            if !model.spaces.isEmpty {
                Section {
                    ForEach(model.spaces) { space in spaceRow(space) }
                } header: {
                    Text("Spaces", bundle: .module)
                }
            }
            if !model.proposals.isEmpty { suggested }
            if !model.archived.isEmpty {
                Section {
                    ForEach(model.archived) { space in spaceRow(space) }
                } header: {
                    Text("Archived", bundle: .module)
                }
            }
        }
        .homeListStyle()
        .navigationTitle(String(localized: "Spaces", bundle: .module))
        .psycheInlineTitle()
        .refreshable { await model.load() }
        .task {
            await model.load()
            await model.observe()
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

    private var suggested: some View {
        Section {
            ForEach(model.proposals) { proposal in
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: proposal.name).font(.body).lineLimit(2)
                    if !proposal.reason.isEmpty { Text(proposal.reason).font(.footnote).foregroundStyle(.secondary) }
                    if !proposal.chatTitles.isEmpty {
                        Text(proposal.chatTitles.joined(separator: ", ")).font(.footnote).foregroundStyle(.secondary)
                    }
                    if proposal.untrusted {
                        Text(SpacesText.untrustedSuggestion).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .swipeActions(edge: .leading) {
                    Button { Task { _ = await model.accept(proposal) } } label: {
                        Label(String(localized: "Create", bundle: .module), systemImage: "plus")
                    }
                    .tint(.accentColor)
                }
                .swipeActions(edge: .trailing) {
                    Button { Task { await model.dismiss(proposal) } } label: {
                        Label(String(localized: "Not now", bundle: .module), systemImage: "xmark")
                    }
                }
                .contextMenu {
                    Button { Task { _ = await model.accept(proposal) } } label: {
                        Label(String(localized: "Create", bundle: .module), systemImage: "plus")
                    }
                    Button { Task { await model.dismiss(proposal) } } label: {
                        Label(String(localized: "Not now", bundle: .module), systemImage: "xmark")
                    }
                }
            }
        } header: {
            Text("Suggested", bundle: .module)
        }
    }

    private func spaceRow(_ space: SpaceItem) -> some View {
        NavigationLink { RouteView(route: .space(id: space.id)) } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(space.name).font(.body).lineLimit(1)
                if !space.description.isEmpty {
                    Text(space.description).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }
}

// MARK: Space page

/// One Space: trackers on top, then Instructions, Chats, Work due, Automations, and Files and links. Trackers and
/// links are added and removed here; folders and Space settings are shown with "Change on your Mac".
struct SpaceView: View {
    @State private var model: SpaceModel
    @State private var editing = false
    @State private var addingTracker = false
    @State private var managingTrackers = false
    @State private var managingLinks = false
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
                .disabled(
                    model.phase.value == nil || !session.state.canAnswer || model.phase.value?.space.archived == true)
            }
            ToolbarItem(placement: .primaryAction) {
                if let detail = model.phase.value {
                    SpaceActionsMenu(archived: detail.space.archived) { archive in await model.setArchived(archive) }
                }
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
        .sheet(isPresented: $addingTracker) {
            AddTrackerSheet { template in await model.addTracker(template) }
        }
        .sheet(isPresented: $managingTrackers) {
            TrackersSheet(model: model)
        }
        .sheet(isPresented: $managingLinks) {
            LinksSheet(model: model)
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
        if detail.space.archived {
            Text("Archived. Its automations are paused and its folders are off.", bundle: .module)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
        if !detail.space.description.isEmpty {
            Text(detail.space.description).font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
        trackers(detail)
        instructions(detail.instructions)
        if !model.chats.isEmpty { chats(model.chats) }
        if detail.space.due > 0 || detail.automations > 0 { work(detail) }
        files(detail)
    }

    private func trackers(_ detail: SpaceDetailItem) -> some View {
        let items = detail.trackers
        let editable = !detail.space.archived && session.state.canAnswer
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionHeader(String(localized: "Trackers", bundle: .module), count: items.isEmpty ? nil : items.count)
                Spacer(minLength: 0)
                if !items.isEmpty {
                    Button(String(localized: "Edit", bundle: .module)) { managingTrackers = true }
                        .font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.muted).buttonStyle(.plain)
                        .disabled(!editable)
                }
                Button(String(localized: "Add", bundle: .module)) { addingTracker = true }
                    .font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.inkText).buttonStyle(.plain)
                    .disabled(!editable)
            }
            if !items.isEmpty {
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
            HStack {
                SectionHeader(String(localized: "Files and links", bundle: .module))
                Spacer(minLength: 0)
                Button(String(localized: "Edit", bundle: .module)) { managingLinks = true }
                    .font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.muted).buttonStyle(.plain)
                    .disabled(detail.space.archived || !session.state.canAnswer)
            }
            if detail.folders.isEmpty && detail.links.isEmpty {
                Text("No folders or links yet.", bundle: .module)
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
            } else {
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
            }
            if !detail.folders.isEmpty {
                Text("Change folders and settings on your Mac.", bundle: .module)
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
            }
        }
    }
}

// MARK: Trackers

/// The shelf in an editing list: drag to reorder (the whole order is saved), swipe to remove after a confirmation.
private struct TrackersSheet: View {
    let model: SpaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var pendingRemoval: SpaceTrackerItem?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.phase.value?.trackers ?? []) { tracker in
                    Text(verbatim: model.widgets[tracker.widgetID]?.title ?? String(localized: "Tracker", bundle: .module))
                        .font(.psycheRow)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { pendingRemoval = tracker } label: {
                                Label(String(localized: "Remove", bundle: .module), systemImage: "minus.circle")
                            }
                        }
                }
                .onMove { from, to in
                    var ids = (model.phase.value?.trackers ?? []).map(\.widgetID)
                    ids.move(fromOffsets: from, toOffset: to)
                    Task { await model.reorderTrackers(ids) }
                }
            }
            #if os(iOS)
            .environment(\.editMode, .constant(.active))
            #endif
            .navigationTitle(String(localized: "Edit trackers", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done", bundle: .module)) { dismiss() }
                }
            }
            .confirmationDialog(
                String(localized: "Remove this tracker from the Space?", bundle: .module),
                isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
                titleVisibility: .visible
            ) {
                Button(String(localized: "Remove", bundle: .module), role: .destructive) {
                    if let tracker = pendingRemoval { Task { await model.removeTracker(tracker) } }
                    pendingRemoval = nil
                }
                Button(String(localized: "Cancel", bundle: .module), role: .cancel) { pendingRemoval = nil }
            } message: {
                Text("The widget goes back to its chat.", bundle: .module)
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Pick a template from the Mac's list and put it on the shelf.
private struct AddTrackerSheet: View {
    let add: (SpaceTrackerTemplateItem) async -> Bool
    @State private var template: SpaceTrackerTemplateItem = .workDue
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Picker(selection: $template) {
                    ForEach(SpaceTrackerTemplateItem.allCases) { item in
                        Text(verbatim: SpacesText.templateName(item)).tag(item)
                    }
                } label: {
                    Text("Template", bundle: .module)
                }
            }
            .navigationTitle(String(localized: "Add a tracker", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Add", bundle: .module)) {
                        saving = true
                        Task {
                            if await add(template) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(saving)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: Links

/// The Space's links: swipe to remove after a confirmation, and Add opens the address form.
private struct LinksSheet: View {
    let model: SpaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    @State private var pendingRemoval: SpaceLinkItem?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.phase.value?.links ?? []) { link in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: link.label).font(.psycheRow).lineLimit(2)
                        if link.untrusted { EvidenceLine([String(localized: "From an outside source", bundle: .module)]) }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { pendingRemoval = link } label: {
                            Label(String(localized: "Remove", bundle: .module), systemImage: "trash")
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "Files and links", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Done", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Add link", bundle: .module)) { adding = true }
                }
            }
            .confirmationDialog(
                String(localized: "Remove this link?", bundle: .module),
                isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
                titleVisibility: .visible
            ) {
                Button(String(localized: "Remove", bundle: .module), role: .destructive) {
                    if let link = pendingRemoval { Task { await model.removeLink(link) } }
                    pendingRemoval = nil
                }
                Button(String(localized: "Cancel", bundle: .module), role: .cancel) { pendingRemoval = nil }
            } message: {
                Text("It leaves this Space. The page itself is untouched.", bundle: .module)
            }
            .sheet(isPresented: $adding) {
                AddLinkSheet { url, title in await model.addLink(url: url, title: title) }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// An http or https address with an optional title. The error shows only after the owner types, and Save waits for
/// a valid address.
private struct AddLinkSheet: View {
    let add: (String, String) async -> Bool
    @State private var address = ""
    @State private var title = ""
    @State private var addressEdited = false
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    private var valid: String? { SpaceLinkAddress.parse(address) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(text: $address) {
                        Text("Address", bundle: .module)
                    }
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                    .onChange(of: address) { _, _ in addressEdited = true }
                    TextField(text: $title) {
                        Text("Title (optional)", bundle: .module)
                    }
                } footer: {
                    if addressEdited && valid == nil {
                        Text("Enter a web address that starts with http:// or https://.", bundle: .module)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(String(localized: "Add link", bundle: .module))
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save", bundle: .module)) {
                        guard let url = valid else { return }
                        saving = true
                        Task {
                            if await add(url, title) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(valid == nil || saving)
                }
            }
        }
        .presentationDetents([.medium])
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
