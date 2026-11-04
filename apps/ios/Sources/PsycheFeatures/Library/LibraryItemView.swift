#if os(iOS)
import PsycheDesign
import PsycheStore
import SwiftUI

/// One file (route `.file(id)`): its paper sheet, title, evidence line, where it's used, and Quick Look
/// when the phone has the file. Read-mostly: editing happens on the Mac.
struct LibraryItemView: View {
    let id: String
    @Environment(\.backend) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: ItemModel?

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
    }
}

@MainActor @Observable
final class ItemModel {
    enum Phase { case loading, loaded(PsycheStore.LibraryItem), gone, failed(String) }
    private(set) var phase: Phase = .loading
    private(set) var file: URL?
    private(set) var deleting = false
    private(set) var deleteError: String?
    let id: String
    private let store: any PsycheBackend

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    func load() async {
        do {
            let item = try await store.libraryItem(id: id)
            file = try? await store.libraryFile(id: id)
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
    @State private var preview = false
    @State private var confirmDelete = false

    var body: some View {
        ScrollView {
            switch model.phase {
            case .loading:
                ItemBody(item: .skeletonItem, file: nil, preview: $preview, confirmDelete: $confirmDelete)
                    .redacted(reason: .placeholder).allowsHitTesting(false)
            case .loaded(let item):
                ItemBody(item: item, file: model.file, preview: $preview, confirmDelete: $confirmDelete)
            case .gone:
                message("That file is gone", "It was deleted, here or on your Mac.")
            case .failed(let text):
                VStack(spacing: 12) {
                    message("Couldn't load this", text)
                    Button("Try again") { Task { await model.load() } }.buttonStyle(.psycheOutline).frame(maxWidth: 220)
                }
            }
        }
        .psycheScreen()
        .psycheInlineTitle()
        .navigationTitle("")
        .toolbar {
            if case .loaded(let item) = model.phase {
                ToolbarItem(placement: .primaryAction) { shareButton(item) }
            }
        }
        .task { await model.load() }
        .task { await model.observe() }
        .fullScreenCover(isPresented: $preview) {
            if let url = model.file { QuickLookPreview(url: url) { preview = false }.ignoresSafeArea() }
        }
        .confirmationDialog("Delete this file?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task { if await model.delete() { dismissPage() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It's removed from your Library on your Mac too. Chats that used it keep their copy of the text.")
        }
        .alert("Couldn't delete", isPresented: Binding(get: { model.deleteError != nil }, set: { if !$0 { model.clearDeleteError() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.deleteError ?? "")
        }
    }

    @ViewBuilder
    private func shareButton(_ item: PsycheStore.LibraryItem) -> some View {
        if let url = model.file {
            ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
        } else {
            ShareLink(item: item.title) { Image(systemName: "square.and.arrow.up") }
        }
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
    let file: URL?
    @Binding var preview: Bool
    @Binding var confirmDelete: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Button { if file != nil { preview = true } } label: {
                LibraryThumbnail(item: item, style: .tile)
                    .frame(maxWidth: 220)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .disabled(file == nil)
            .accessibilityLabel(file == nil ? "\(item.title), preview" : "Open \(item.title)")

            VStack(alignment: .leading, spacing: 6) {
                Text(item.title).psycheTitle(.title2).foregroundStyle(PsycheColor.text)
                Text(item.detail).font(.subheadline).foregroundStyle(PsycheColor.muted)
                EvidenceLine(evidence)
            }

            if let threadID = item.threadID {
                NavigationLink(value: Route.thread(id: threadID)) {
                    HStack(spacing: 8) {
                        Text("Used in").foregroundStyle(PsycheColor.muted)
                        Text(item.threadTitle ?? "a chat").foregroundStyle(PsycheColor.inkText).fontWeight(.medium)
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

            if file != nil {
                Button { preview = true } label: { Label("Open", systemImage: "eye") }
                    .buttonStyle(.psycheInk)
            } else {
                PaperCard(padding: 14) {
                    HStack(spacing: 10) {
                        Image(systemName: "desktopcomputer").foregroundStyle(PsycheColor.muted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Open on your Mac").font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.text)
                            Text("This one isn't kept on your phone. It lives in your Library on your Mac.")
                                .font(.footnote).foregroundStyle(PsycheColor.muted)
                        }
                    }
                }
            }

            Button(role: .destructive) { confirmDelete = true } label: {
                Label("Delete", systemImage: "trash").foregroundStyle(PsycheColor.red)
            }
            .buttonStyle(.psycheOutline)
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.top, 8).padding(.bottom, 32)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
    }

    private var evidence: [String] {
        item.evidence.isEmpty ? [item.section.rawValue, item.fileType.uppercased()].filter { !$0.isEmpty } : item.evidence
    }
}

private extension PsycheStore.LibraryItem {
    static let skeletonItem = PsycheStore.LibraryItem(id: "sklib0", title: "Placeholder file name", section: .documents, fileType: "pdf", detail: "Placeholder detail text")
}
#endif
