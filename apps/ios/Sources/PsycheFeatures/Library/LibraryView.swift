#if os(iOS)
import PsycheDesign
import PsycheStore
import SwiftUI

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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let wide = proxy.size.width >= 560
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PageHeader("Library")
                    SectionPicker(selection: $model.section)
                    ForEach(model.uploads) { job in
                        UploadRow(job: job, retry: { model.retry(job.id) }, dismiss: { model.dismiss(job.id) })
                    }
                    PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { items in
                        if items.isEmpty && model.uploads.isEmpty {
                            EmptySection(section: model.section)
                        } else if wide {
                            LibraryGrid(items: items)
                        } else {
                            LibraryList(items: items)
                        }
                    }
                }
                .padding(.horizontal, PsycheMetrics.pagePadding)
                .padding(.top, 8)
                .padding(.bottom, 96)
            }
            .refreshable { await model.refresh() }
        }
        .psycheScreen(maxWidth: nil)
        .psycheHidesNavigationBar()
        .overlay(alignment: .bottomTrailing) {
            UploadMenuButton { model.upload($0) }
                .padding(.trailing, PsycheMetrics.pagePadding)
                .padding(.bottom, 16)
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: model.uploads.count)
        .task(id: model.section) { await model.load() }
        .task { await model.observe() }
    }
}

/// The four sections. The container is the screen's glass chrome; the selection is a quiet sheet-colored thumb.
private struct SectionPicker: View {
    @Binding var selection: LibrarySection
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 2) {
            ForEach(LibrarySection.allCases) { section in
                Button { selection = section } label: {
                    Text(section.rawValue)
                        .font(.subheadline.weight(selection == section ? .semibold : .regular))
                        .foregroundStyle(selection == section ? PsycheColor.text : PsycheColor.muted)
                        .lineLimit(1).minimumScaleFactor(0.6)
                        .padding(.horizontal, 4)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background {
                            if selection == section {
                                Capsule().fill(PsycheColor.sheet)
                                    .overlay(Capsule().strokeBorder(PsycheColor.hairline, lineWidth: 1))
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == section ? .isSelected : [])
            }
        }
        .padding(3)
        .glassEffect(.regular, in: .capsule)
        .animation(.smooth(duration: 0.2), value: selection)
    }
}

private struct LibraryList: View {
    let items: [PsycheStore.LibraryItem]

    var body: some View {
        PaperCard {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider().padding(.leading, 70) }
                    NavigationLink(value: Route.file(id: item.id)) { LibraryRow(item: item) }
                        .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct LibraryRow: View {
    let item: PsycheStore.LibraryItem

    var body: some View {
        HStack(spacing: 14) {
            LibraryThumbnail(item: item, style: .row)
                .frame(width: 42, height: 54)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                    .lineLimit(2).multilineTextAlignment(.leading)
                Text(item.detail)
                    .font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                    .lineLimit(2).multilineTextAlignment(.leading)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.rule)
                .accessibilityHidden(true)
        }
        .padding(PsycheMetrics.rowPadding)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct LibraryGrid: View {
    let items: [PsycheStore.LibraryItem]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 220), spacing: 18, alignment: .top)], spacing: 22) {
            ForEach(items) { item in
                NavigationLink(value: Route.file(id: item.id)) {
                    VStack(alignment: .leading, spacing: 8) {
                        LibraryThumbnail(item: item, style: .tile)
                        Text(item.title)
                            .font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        Text(item.detail)
                            .font(.psycheMono(.caption2)).foregroundStyle(PsycheColor.muted)
                            .lineLimit(2).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct EmptySection: View {
    let section: LibrarySection

    var body: some View {
        VStack(spacing: 14) {
            PaperSheet(fold: 14) {
                Text(section.rawValue.prefix(3).uppercased())
                    .font(.psycheMono(.caption, weight: .semibold)).foregroundStyle(PsycheColor.rule)
            }
            .frame(width: 72, height: 94)
            Text(headline).font(.headline).foregroundStyle(PsycheColor.text)
            Text(hint)
                .font(.subheadline).foregroundStyle(PsycheColor.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
        .padding(.horizontal, 24)
    }

    private var headline: String {
        switch section {
        case .documents: "No documents yet"
        case .images: "No images yet"
        case .artifacts: "Nothing built yet"
        case .downloads: "No downloads yet"
        }
    }

    private var hint: String {
        switch section {
        case .documents: "PDFs, slides and notes Psyche reads or writes for you land here. Add one with +, or share it from any app."
        case .images: "Photos you add with + or share from your photo library show up here."
        case .artifacts: "Pages, checklists and small tools Psyche builds for you are kept here."
        case .downloads: "Files Psyche fetches from the web for a task are kept here."
        }
    }
}

private struct UploadRow: View {
    let job: UploadJob
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        PaperCard(padding: PsycheMetrics.rowPadding) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(job.name).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text).lineLimit(1)
                    Spacer(minLength: 8)
                    if job.failure == nil {
                        Text("\(Int(job.progress * 100))%").font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                    }
                }
                if let failure = job.failure {
                    Text(failure).font(.footnote).foregroundStyle(PsycheColor.muted)
                    HStack(spacing: 16) {
                        Button("Try again", action: retry)
                        Button("Dismiss", role: .cancel, action: dismiss)
                    }
                    .font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.inkText)
                } else {
                    ProgressBar(fraction: job.progress)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(job.failure ?? "\(Int(job.progress * 100)) percent")
    }
}

private extension UploadJob {
    var name: String { file.name }
}
#endif
