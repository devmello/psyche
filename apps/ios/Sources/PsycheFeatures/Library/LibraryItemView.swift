#if os(iOS)
import PsycheDesign
import PsycheStore
import SwiftUI

/// One file (route `.file(id)`): its paper sheet, title, evidence line, where it's used, and Quick Look once
/// the phone has it. "Open" downloads the file on demand (with progress and Cancel); a file the Mac holds back
/// (quarantined, or too big) says why instead. Read-mostly: editing happens on the Mac.
struct LibraryItemView: View {
    let id: String
    @Environment(\.backend) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: ItemModel?
    @Environment(\.psycheZoomNamespace) private var zoom

    var body: some View {
        Group {
            if let model {
                ItemContent(model: model, dismissPage: { dismiss() })
            } else {
                Color.clear.psycheScreen()
            }
        }
        .task {
            if model == nil { model = ItemModel(id: id, store: store) }
        }
        // The page grows out of the thumbnail that was tapped, and shrinks back into it on the way out.
        .psycheZoomDestination(id: id, in: zoom)
    }
}

@MainActor @Observable
final class ItemModel {
    enum Phase { case loading, loaded(PsycheStore.LibraryItem), gone, failed(String) }
    private(set) var phase: Phase = .loading
    var isLoading: Bool {
        if case .loading = phase { return true }
        return false
    }
    /// The local copy, once downloaded for this visit (nil until "Open").
    private(set) var file: URL?
    /// Quick Look is presented.
    var preview = false
    /// A download is running; `downloadProgress` is 0...1 once the first chunk has arrived.
    private(set) var downloading = false
    private(set) var downloadProgress: Double = 0
    private(set) var openError: String?
    private(set) var deleting = false
    private(set) var deleteError: String?
    let id: String
    private let store: any PsycheBackend
    private var downloadTask: Task<Void, Never>?

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    func load() async {
        do {
            let item = try await store.libraryItem(id: id)
            phase = .loaded(item)
        } catch BackendError.notFound {
            phase = .gone
        } catch {
            if case .loaded = phase { return }
            phase = .failed(error.localizedDescription)
        }
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.library), .resynced: if !deleting { await load() }
            default: break
            }
        }
    }

    /// "Open": opens the local copy, or downloads it first. Does nothing for a file the Mac holds back.
    func open() {
        if file != nil { preview = true; return }
        guard !downloading, case .loaded(let item) = phase, item.refusal == nil else { return }
        openError = nil
        downloading = true
        downloadTask = Task { await download() }
    }

    /// Stops a running download; the partial file is removed by the backend.
    func cancelOpen() { downloadTask?.cancel() }

    private func download() async {
        downloadProgress = 0
        defer {
            downloading = false
            downloadTask = nil
        }
        do {
            let url = try await store.downloadLibraryFile(id: id) { [weak self] value in
                Task { @MainActor in self?.downloadProgress = value }
            }
            file = url
            preview = true
        } catch is CancellationError {
            // Cancelled by the owner: nothing to report.
        } catch is LibraryFileRefusal {
            // The Mac refused it after all (say, quarantined since the page loaded): the page reloads and shows why.
            await load()
        } catch {
            openError = error.localizedDescription
        }
    }

    func delete() async -> Bool {
        deleting = true
        defer { deleting = false }
        do {
            try await store.deleteLibraryItem(id: id)
            await ThumbnailLoader.shared.forget(id)
            return true
        } catch {
            deleteError = error.localizedDescription
            return false
        }
    }

    func clearDeleteError() { deleteError = nil }
}

private struct ItemContent: View {
    let model: ItemModel
    let dismissPage: () -> Void
    @State private var confirmDelete = false

    var body: some View {
        ScrollView {
            switch model.phase {
            case .loading:
                ItemBody(item: .skeletonItem, model: model, confirmDelete: $confirmDelete)
                    .redacted(reason: .placeholder).allowsHitTesting(false)
                    .transition(.opacity)
            case .loaded(let item):
                ItemBody(item: item, model: model, confirmDelete: $confirmDelete)
                    .transition(.opacity)
            case .gone:
                message(String(localized: "That file is gone", bundle: .module), String(localized: "It was deleted, here or on your Mac.", bundle: .module))
            case .failed(let text):
                VStack(spacing: 12) {
                    message(String(localized: "Couldn't load this", bundle: .module), text)
                    Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }.buttonStyle(.psycheOutline).frame(maxWidth: 220)
                }
            }
        }
        .psycheScreen()
        .psycheFade(PsycheMotion.Duration.short, value: model.isLoading)
        .psycheInlineTitle()
        .navigationTitle("")
        .toolbar {
            if let url = model.file {
                ToolbarItem(placement: .primaryAction) { shareButton(url) }
            }
        }
        .task { await model.load() }
        .task { await model.observe() }
        .fullScreenCover(isPresented: Binding(get: { model.preview }, set: { model.preview = $0 })) {
            if let url = model.file { QuickLookPreview(url: url) { model.preview = false }.ignoresSafeArea() }
        }
        .confirmationDialog(String(localized: "Delete this file?", bundle: .module), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(String(localized: "Delete", bundle: .module), role: .destructive) {
                Task { if await model.delete() { dismissPage() } }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("It's removed from your Library on your Mac too. Chats that used it keep their copy of the text.", bundle: .module)
        }
        .alert(String(localized: "Couldn't delete", bundle: .module), isPresented: Binding(get: { model.deleteError != nil }, set: { if !$0 { model.clearDeleteError() } })) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(model.deleteError ?? "")
        }
    }

    private func shareButton(_ url: URL) -> some View {
        ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
            .accessibilityLabel(String(localized: "Share", bundle: .module))
    }

    private func message(_ title: String, _ detail: String) -> some View {
        VStack(spacing: 8) {
            Text(title).font(.headline).foregroundStyle(PsycheColor.text)
            Text(detail).font(.subheadline).foregroundStyle(PsycheColor.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 60).padding(.horizontal, 24)
    }
}

private struct ItemBody: View {
    let item: PsycheStore.LibraryItem
    let model: ItemModel
    @Binding var confirmDelete: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Button { model.open() } label: {
                LibraryThumbnail(item: item, style: .tile)
                    .frame(maxWidth: 220)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .allowsHitTesting(item.refusal == nil)
            .accessibilityLabel(item.refusal == nil ? "Open \(item.title)" : "\(item.title), preview")

            VStack(alignment: .leading, spacing: 6) {
                Text(item.title).psycheTitle(.title2).foregroundStyle(PsycheColor.text)
                Text(item.detail).font(.subheadline).foregroundStyle(PsycheColor.muted)
                EvidenceLine(evidence)
            }

            if let threadID = item.threadID {
                NavigationLink(value: Route.thread(id: threadID)) {
                    HStack(spacing: 8) {
                        Text("Used in", bundle: .module).foregroundStyle(PsycheColor.muted)
                        Text(item.threadTitle ?? String(localized: "a chat", bundle: .module)).foregroundStyle(PsycheColor.inkText).fontWeight(.medium)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.rule)
                    }
                    .font(.subheadline)
                    .padding(PsycheMetrics.rowPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous).strokeBorder(PsycheColor.hairline))
                }
                .buttonStyle(.plain)
            }

            openSection

            Button(role: .destructive) { confirmDelete = true } label: {
                Label(String(localized: "Delete", bundle: .module), systemImage: "trash").foregroundStyle(PsycheColor.red)
            }
            .buttonStyle(.psycheOutline)
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.top, 8).padding(.bottom, 32)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var openSection: some View {
        if let refusal = item.refusal {
            PaperCard(padding: 14) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: refusal == .quarantined ? "shield.lefthalf.filled" : "desktopcomputer").foregroundStyle(PsycheColor.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(refusal.title).font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.text)
                        Text(refusal.detail).font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
        } else if model.downloading {
            PaperCard(padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    ProgressView(value: model.downloadProgress)
                    HStack {
                        Text("Downloading…", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        Spacer(minLength: 8)
                        Button(String(localized: "Cancel", bundle: .module)) { model.cancelOpen() }.buttonStyle(.psycheOutline).frame(maxWidth: 140)
                    }
                }
            }
        } else {
            Button { model.open() } label: { Label(String(localized: "Open", bundle: .module), systemImage: "eye") }
                .buttonStyle(.psycheInk)
            if let error = model.openError {
                Text(error).font(.footnote).foregroundStyle(PsycheColor.red)
            }
        }
    }

    private var evidence: [String] {
        item.evidence.isEmpty ? [item.section.rawValue, item.fileType.uppercased()].filter { !$0.isEmpty } : item.evidence
    }
}

private extension LibraryFileRefusal {
    var title: String {
        switch self {
        case .quarantined: String(localized: "Held on your Mac", bundle: .module)
        case .tooLarge, .unavailable: String(localized: "Open on your Mac", bundle: .module)
        }
    }

    var detail: String {
        switch self {
        case .quarantined: String(localized: "It came from outside, so it's quarantined on your Mac. Trust it there to open it here.", bundle: .module)
        case .tooLarge: String(localized: "It's bigger than 64 MB, so it opens on your Mac.", bundle: .module)
        case .unavailable: String(localized: "This one isn't kept on your phone. It lives in your Library on your Mac.", bundle: .module)
        }
    }
}

private extension PsycheStore.LibraryItem {
    static let skeletonItem = PsycheStore.LibraryItem(id: "sklib0", title: "Placeholder file name", section: .documents, fileType: "pdf", detail: "Placeholder detail text")
}
#endif
