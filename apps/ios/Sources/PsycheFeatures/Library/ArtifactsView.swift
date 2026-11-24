#if os(iOS)
import PsycheDesign
import PsycheStore
import SwiftUI

/// Artifacts: the documents and pages Psyche made (`artifacts.list`). Each opens its content (`artifacts.read`);
/// its versions sit behind the toolbar.
struct ArtifactsView: View {
    @Environment(\.backend) private var backend
    @State private var artifacts: [ArtifactItem] = []
    @State private var nextCursor: String?
    @State private var loading = false
    @State private var failed = false
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !loaded && loading {
                    Color.clear.frame(height: 200)
                } else if artifacts.isEmpty && failed {
                    FailedNotice { Task { await load(after: nil) } }
                } else if artifacts.isEmpty {
                    Text("No artifacts yet", bundle: .module).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                    Text("Artifacts appear here when Psyche makes a document or page.", bundle: .module)
                        .font(.footnote).foregroundStyle(PsycheColor.muted)
                } else {
                    PaperCard {
                        VStack(spacing: 0) {
                            ForEach(Array(artifacts.enumerated()), id: \.element.id) { index, artifact in
                                if index > 0 { HairlineDivider().padding(.leading, 14) }
                                NavigationLink { ArtifactViewerView(artifact: artifact) } label: { ArtifactRow(artifact: artifact) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                    if nextCursor != nil {
                        Button(String(localized: "Load more", bundle: .module)) { Task { await load(after: nextCursor) } }
                            .buttonStyle(.psycheOutline)
                            .disabled(loading)
                    }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .refreshable { await load(after: nil) }
        .psycheScreen()
        .psycheInlineTitle()
        .navigationTitle(String(localized: "Artifacts", bundle: .module))
        .task { if !loaded { await load(after: nil) } }
    }

    private func load(after cursor: String?) async {
        loading = true
        defer { loading = false }
        do {
            let page = try await backend.artifacts(cursor: cursor)
            artifacts = cursor == nil ? page.artifacts : artifacts + page.artifacts
            nextCursor = page.nextCursor
            failed = false
        } catch {
            failed = true
        }
        loaded = true
    }
}

private struct ArtifactRow: View {
    let artifact: ArtifactItem

    var body: some View {
        HStack(spacing: 12) {
            Text(verbatim: artifact.type.uppercased())
                .font(.psycheMono(.caption2, weight: .semibold)).foregroundStyle(PsycheColor.muted)
                .frame(width: 40, height: 48)
                .background(PsycheColor.paper, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(PsycheColor.rule, lineWidth: 1))
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: artifact.title).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                    .lineLimit(2).multilineTextAlignment(.leading)
                Text(verbatim: "\(artifact.updatedAt) \u{00B7} v\(artifact.version)")
                    .font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.rule)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// One artifact's content at its latest version. HTML opens in Quick Look (a local .html copy); other types show
/// their text. The toolbar's Versions opens the history, where an old version can be restored.
struct ArtifactViewerView: View {
    let artifact: ArtifactItem
    @Environment(\.backend) private var backend
    @State private var content: ArtifactContent?
    @State private var failed = false
    @State private var previewURL: URL?
    @State private var showingVersions = false
    @State private var title: String

    init(artifact: ArtifactItem) {
        self.artifact = artifact
        _title = State(initialValue: artifact.title)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let content {
                    Text(verbatim: "\(String(localized: "Version", bundle: .module)) \(content.version)")
                        .font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                    if artifact.isHTML {
                        Button(String(localized: "Open preview", bundle: .module)) { openPreview(content) }
                            .buttonStyle(.psycheOutline).frame(maxWidth: 220)
                    }
                    PaperCard {
                        Text(verbatim: content.content)
                            .font(.psycheMono(.footnote)).foregroundStyle(PsycheColor.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                    }
                } else if failed {
                    FailedNotice { Task { await load() } }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(String(localized: "Versions", bundle: .module)) { showingVersions = true }
            }
        }
        .sheet(isPresented: $showingVersions) {
            NavigationStack {
                ArtifactVersionsView(artifact: artifact) { restored in
                    showingVersions = false
                    if restored { Task { await load() } }
                }
            }
        }
        .fullScreenCover(isPresented: Binding(get: { previewURL != nil }, set: { if !$0 { previewURL = nil } })) {
            if let previewURL { QuickLookPreview(url: previewURL) { self.previewURL = nil }.ignoresSafeArea() }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            content = try await backend.artifactContent(id: artifact.id, version: nil)
            failed = false
        } catch {
            failed = true
        }
    }

    /// Writes the HTML to the caches directory (one file per version) and hands it to Quick Look.
    private func openPreview(_ content: ArtifactContent) {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("artifact-\(artifact.id)-v\(content.version).html")
        do {
            try Data(content.content.utf8).write(to: url, options: .atomic)
            previewURL = url
        } catch {
            failed = true
        }
    }
}

/// The version history, newest first. Restore asks first, with an explicit Cancel; nothing is deleted.
struct ArtifactVersionsView: View {
    let artifact: ArtifactItem
    /// Called with `true` when a version was restored, so the viewer reloads.
    let done: (Bool) -> Void
    @Environment(\.backend) private var backend
    @State private var versions: [ArtifactVersionItem] = []
    @State private var failed = false
    @State private var pending: ArtifactVersionItem?
    @State private var restoreFailed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if failed {
                    FailedNotice { Task { await load() } }
                }
                PaperCard {
                    VStack(spacing: 0) {
                        ForEach(Array(versions.reversed().enumerated()), id: \.element.id) { index, version in
                            if index > 0 { HairlineDivider().padding(.leading, 14) }
                            HStack(alignment: .top, spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 8) {
                                        Text("Version \(version.version)", bundle: .module)
                                            .font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                                        if index == 0 {
                                            Text("Latest", bundle: .module).font(.caption).foregroundStyle(PsycheColor.muted)
                                        }
                                    }
                                    Text(verbatim: version.summary).font(.footnote).foregroundStyle(PsycheColor.muted)
                                    Text(verbatim: version.createdAt).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                                    if let from = version.restoredFrom {
                                        Text("Restored from version \(from)", bundle: .module)
                                            .font(.caption).foregroundStyle(PsycheColor.muted)
                                    }
                                }
                                Spacer(minLength: 8)
                                if index != 0 {
                                    Button(String(localized: "Restore", bundle: .module)) { pending = version }
                                        .buttonStyle(.psycheOutline)
                                }
                            }
                            .padding(.horizontal, 14).padding(.vertical, 12)
                        }
                    }
                }
                if restoreFailed {
                    Text("Couldn't restore this version. Try again.", bundle: .module).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .psycheScreen()
        .psycheInlineTitle()
        .navigationTitle(String(localized: "Versions", bundle: .module))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(String(localized: "Close", bundle: .module)) { done(false) }
            }
        }
        .confirmationDialog(
            String(localized: "Restore this version?", bundle: .module),
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            titleVisibility: .visible
        ) {
            Button(String(localized: "Restore", bundle: .module)) {
                if let pending { Task { await restore(pending) } }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) { pending = nil }
        } message: {
            Text("It becomes the latest version. Nothing is deleted.", bundle: .module)
        }
        .task { await load() }
    }

    private func load() async {
        do {
            versions = try await backend.artifactVersions(id: artifact.id)
            failed = false
        } catch {
            failed = true
        }
    }

    private func restore(_ version: ArtifactVersionItem) async {
        pending = nil
        do {
            _ = try await backend.restoreArtifact(id: artifact.id, version: version.version)
            restoreFailed = false
            done(true)
        } catch {
            restoreFailed = true
        }
    }
}
#endif
