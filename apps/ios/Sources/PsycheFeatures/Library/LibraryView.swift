#if os(iOS)
import PsycheDesign
import PsycheStore
import SwiftUI
import UIKit

/// Documents, images, artifacts and downloads as paper sheets (docs/design/ios-app-2026.md §4.4): a grid
/// on iPad and wide phones, a list on compact. The + button uploads from Photos, Files or the scanner.
struct LibraryView: View {
    @Environment(\.backend) private var store
    @State private var model: LibraryModel?

    var body: some View {
        Group {
            if let model {
                LibraryContent(model: model)
            } else {
                Color.clear.psycheScreen()
            }
        }
        .task {
            if model == nil { model = LibraryModel(store: store) }
        }
    }
}

private struct LibraryContent: View {
    @Bindable var model: LibraryModel
    private let motion = MotionContext()
    @State private var query = ""
    @State private var deleting: PsycheStore.LibraryItem?

    /// The loaded rows narrowed by the search field (title and detail line).
    private func shown(_ items: [PsycheStore.LibraryItem]) -> [PsycheStore.LibraryItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return items }
        return items.filter { $0.title.localizedStandardContains(needle) || $0.detail.localizedStandardContains(needle) }
    }

    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        GeometryReader { proxy in
            if proxy.size.width >= 560 { gridBody } else { listBody }
        }
        .navigationTitle(String(localized: "Library", bundle: .module))
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, prompt: String(localized: "Search Library", bundle: .module))
        .toolbar {
            ToolbarItem(placement: .primaryAction) { filterMenu }
            ToolbarItem(placement: .primaryAction) { UploadMenuButton { model.upload($0) } }
        }
        .confirmationDialog(
            String(localized: "Delete this file?", bundle: .module), isPresented: deleteShown, titleVisibility: .visible
        ) {
            Button(String(localized: "Delete", bundle: .module), role: .destructive) {
                if let item = deleting { Task { await model.delete(item) } }
                deleting = nil
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) { deleting = nil }
        } message: {
            Text("It's removed from your Library on your Mac too. Chats that used it keep their copy of the text.", bundle: .module)
        }
        .alert(String(localized: "Couldn't delete", bundle: .module), isPresented: Binding(get: { model.deleteError != nil }, set: { if !$0 { model.clearDeleteError() } })) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.deleteError ?? "")
        }
        .psycheAnimation(.smooth, value: model.uploads.map(\.id))
        .task(id: model.section) { await model.load() }
        .task { await model.observe() }
    }

    private var deleteShown: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    /// Documents, Images and Artifacts, with Downloads and Recordings, behind one native filter menu.
    private var filterMenu: some View {
        Menu {
            Picker(String(localized: "Show", bundle: .module), selection: $model.section) {
                ForEach(LibrarySection.allCases) { section in
                    Text(section.pickerTitle).tag(section)
                }
            }
        } label: {
            Label(String(localized: "Filter", bundle: .module), systemImage: "line.3.horizontal.decrease")
        }
        .accessibilityLabel(String(localized: "Filter", bundle: .module))
        .accessibilityValue(model.section.pickerTitle)
    }

    private var receiptsLink: some View {
        NavigationLink { ReceiptsView() } label: {
            Label(String(localized: "Receipts", bundle: .module), systemImage: "receipt")
        }
    }

    // MARK: Compact: a native inset-grouped list

    private var listBody: some View {
        List {
            if !searching {
                Section { receiptsLink }
            }
            if !model.uploads.isEmpty {
                Section {
                    ForEach(model.uploads) { job in
                        UploadRow(job: job, retry: { model.retry(job.id) }, dismiss: { model.dismiss(job.id) })
                    }
                }
            }
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { items in
                let rows = shown(items)
                if items.isEmpty && model.uploads.isEmpty {
                    EmptySection(section: model.section).listRowBackground(Color.clear)
                } else if rows.isEmpty && searching {
                    ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                } else {
                    // The section's name is a real header, not a subtitle pressed against the large title.
                    Section(model.section.pickerTitle) {
                        ForEach(rows) { item in
                            LibraryListRow(item: item, delete: { deleting = item })
                        }
                        PagedRowsEnd(
                            moreFailed: model.moreFailed, nextCursor: model.nextCursor, loadingMore: model.loadingMore,
                            label: String(localized: "Loading more files", bundle: .module),
                            loadMore: { await model.loadMore() }, retryMore: { await model.retryMore() })
                        .listRowBackground(Color.clear)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.refresh() }
    }

    // MARK: Wide: a grid of thumbnails

    private var gridBody: some View {
        ScrollView {
            // Lazy, so the end row only asks for the next page once it is on screen (`PagedRowsEnd`).
            LazyVStack(alignment: .leading, spacing: 18) {
                if !searching {
                    receiptsLink
                        .padding(PsycheMetrics.rowPadding)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
                }
                ForEach(model.uploads) { job in
                    UploadRow(job: job, retry: { model.retry(job.id) }, dismiss: { model.dismiss(job.id) })
                        .transition(motion.transition(.rise))
                }
                PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { items in
                    let rows = shown(items)
                    if items.isEmpty && model.uploads.isEmpty {
                        EmptySection(section: model.section)
                    } else if rows.isEmpty && searching {
                        ContentUnavailableView.search(text: query)
                    } else {
                        Text(model.section.pickerTitle).font(.headline).accessibilityAddTraits(.isHeader)
                    LibraryGrid(items: rows, delete: { deleting = $0 })
                        PagedRowsEnd(
                            moreFailed: model.moreFailed, nextCursor: model.nextCursor, loadingMore: model.loadingMore,
                            label: String(localized: "Loading more files", bundle: .module),
                            loadMore: { await model.loadMore() }, retryMore: { await model.retryMore() })
                    }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .refreshable { await model.refresh() }
    }
}

extension PsycheStore.LibraryItem {
    /// Where a row goes: an artifact opens its viewer, anything else its file page.
    var route: Route { artifactID.map { Route.artifact(id: $0) } ?? Route.file(id: id) }
}

/// A file row in the list: the thumbnail, title and detail line, with swipe and context-menu actions.
private struct LibraryListRow: View {
    let item: PsycheStore.LibraryItem
    let delete: () -> Void
    @Environment(\.psycheZoomNamespace) private var zoom
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationLink(value: item.route) {
            // At accessibility sizes the thumbnail sits above the text so the title keeps the full row width.
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 14))
            layout {
                LibraryThumbnail(item: item, style: .row)
                    .frame(width: 42, height: 54)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).font(.body).lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
                    Text(item.detail).font(.footnote).foregroundStyle(.secondary).lineLimit(typeSize.isAccessibilitySize ? 3 : 2)
                }
            }
            .padding(.vertical, 2)
        }
        .psycheZoomSource(id: item.id, in: zoom)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive, action: delete) {
                Label(String(localized: "Delete", bundle: .module), systemImage: "trash")
            }
        }
        .contextMenu { LibraryItemActions(item: item, delete: delete) }
    }
}

/// What a long press on a file offers, in the list and the grid.
private struct LibraryItemActions: View {
    let item: PsycheStore.LibraryItem
    let delete: () -> Void

    var body: some View {
        Button { UIPasteboard.general.string = item.title } label: {
            Label(String(localized: "Copy name", bundle: .module), systemImage: "doc.on.doc")
        }
        Button(role: .destructive, action: delete) {
            Label(String(localized: "Delete", bundle: .module), systemImage: "trash")
        }
    }
}

private struct LibraryGrid: View {
    let items: [PsycheStore.LibraryItem]
    let delete: (PsycheStore.LibraryItem) -> Void
    @Environment(\.psycheZoomNamespace) private var zoom

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 220), spacing: 18, alignment: .top)], spacing: 22) {
            ForEach(items) { item in
                NavigationLink(value: item.route) {
                    VStack(alignment: .leading, spacing: 8) {
                        LibraryThumbnail(item: item, style: .tile)
                        Text(item.title)
                            .font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        Text(item.detail)
                            .font(.caption).foregroundStyle(.secondary)
                            .lineLimit(2).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .psycheZoomSource(id: item.id, in: zoom)
                .accessibilityElement(children: .combine)
                .contextMenu { LibraryItemActions(item: item, delete: { delete(item) }) }
            }
        }
    }
}

private struct EmptySection: View {
    let section: LibrarySection

    var body: some View {
        ContentUnavailableView {
            Label(headline, systemImage: symbol)
        } description: {
            Text(hint)
        }
        .padding(.vertical, 24)
    }

    private var symbol: String {
        switch section {
        case .documents: "doc.text"
        case .images: "photo"
        case .artifacts: "square.stack.3d.up"
        case .downloads: "arrow.down.circle"
        case .recordings: "waveform"
        }
    }

    private var headline: String {
        switch section {
        case .documents: String(localized: "No documents yet", bundle: .module)
        case .images: String(localized: "No images yet", bundle: .module)
        case .artifacts: String(localized: "Nothing built yet", bundle: .module)
        case .downloads: String(localized: "No downloads yet", bundle: .module)
        case .recordings: String(localized: "No recordings yet", bundle: .module)
        }
    }

    private var hint: String {
        switch section {
        case .documents: String(localized: "PDFs, slides and notes Psyche reads or writes for you land here. Add one with +, or share it from any app.", bundle: .module)
        case .images: String(localized: "Photos you add with + or share from your photo library show up here.", bundle: .module)
        case .artifacts: String(localized: "Pages, checklists and small tools Psyche builds for you are kept here.", bundle: .module)
        case .downloads: String(localized: "Files Psyche fetches from the web for a task are kept here.", bundle: .module)
        case .recordings: String(localized: "Voice memos and recordings you make land here.", bundle: .module)
        }
    }
}

extension LibrarySection {
    /// The segment's label, localized (the raw value is the English name used as a key).
    var pickerTitle: String {
        switch self {
        case .documents: String(localized: "Documents", bundle: .module)
        case .images: String(localized: "Images", bundle: .module)
        case .artifacts: String(localized: "Artifacts", bundle: .module)
        case .downloads: String(localized: "Downloads", bundle: .module)
        case .recordings: String(localized: "Recordings", bundle: .module)
        }
    }
}

private struct UploadRow: View {
    let job: UploadJob
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(job.name).font(.body).lineLimit(1)
            if let failure = job.failure {
                Text(failure).font(.footnote).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Button(action: retry) { Text("Try again", bundle: .module).frame(minHeight: 44) }
                    Button(role: .cancel, action: dismiss) { Text("Dismiss", bundle: .module).frame(minHeight: 44) }
                }
                .buttonStyle(.borderless)
                .font(.footnote.weight(.semibold))
            } else {
                ProgressView(value: job.progress)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(job.failure ?? job.progress.formatted(.percent.precision(.fractionLength(0))))
    }
}

private extension UploadJob {
    var name: String { file.name }
}
#endif
