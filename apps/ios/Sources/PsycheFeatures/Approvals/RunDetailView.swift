import PsycheDesign
import PsycheStore
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// One run's details: its steps in order, each with its kind, title, target and time, and the screenshots
/// Psyche saw on it. Reached from the task's run page (`TaskRunView`). Screenshots come only when the Gateway
/// sends the frames; when it does not, the steps show alone and nothing takes the place of a screenshot.
struct RunDetailView: View {
    @State private var model: RunDetailModel
    @State private var enlarged: RunFrameRef?

    init(store: any PsycheBackend, runID: String) {
        _model = State(initialValue: RunDetailModel(store: store, runID: runID))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { list in
                    stepList(list)
                }
                if let error = model.error {
                    StatusDot(.failed, error, textColor: PsycheColor.text)
                }
            }
            .padding(PsycheMetrics.pagePadding)
            .padding(.top, 8)
        }
        .psycheScreen()
        .navigationTitle(String(localized: "Run details", bundle: .module))
        .psycheInlineTitle()
        .task { await model.load() }
        .sheet(item: $enlarged) { frame in
            FrameViewer(model: model, frame: frame)
        }
    }

    // MARK: Steps

    private func stepList(_ list: RunStepList) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Steps", bundle: .module))
            if list.steps.isEmpty {
                Text("No steps recorded yet.", bundle: .module)
                    .font(.subheadline).foregroundStyle(PsycheColor.muted)
            } else {
                PaperCard {
                    ForEach(Array(list.steps.enumerated()), id: \.element.id) { index, step in
                        if index > 0 { HairlineDivider() }
                        stepRow(step)
                    }
                }
            }
            if list.hasMore {
                Button(String(localized: "Load more steps", bundle: .module)) { Task { await model.loadMore() } }
                    .buttonStyle(.bordered)
                    .disabled(model.loadingMore)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }

    private func stepRow(_ step: RunStepRow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: Self.symbol(for: step.kind))
                    .font(.body)
                    .foregroundStyle(PsycheColor.muted)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(step.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    if let target = step.target {
                        Text(target).font(.footnote).foregroundStyle(PsycheColor.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 3) {
                    StatusDot(step.status.dot, step.status.label)
                    if let started = step.startedAt {
                        Text(started, style: .time)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(PsycheColor.muted)
                    }
                }
            }
            let frames = model.frames(for: step.id)
            if !frames.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(frames) { frame in
                            Button { enlarged = frame } label: {
                                FrameThumbnail(model: model, frame: frame)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    /// An SF Symbol for each step kind. A kind this build does not know gets a neutral dashed circle.
    static func symbol(for kind: RunStepKindName?) -> String {
        switch kind {
        case .thinking: "brain"
        case .model: "cpu"
        case .tool: "wrench.and.screwdriver"
        case .approval: "checkmark.shield"
        case .question: "questionmark.bubble"
        case .subagent: "person.2"
        case .text: "text.bubble"
        case .memory: "brain.head.profile"
        case .artifact: "doc"
        case .note: "note.text"
        case nil: "circle.dashed"
        }
    }
}

/// A screenshot's thumbnail. It loads its bytes when it appears and keeps its place while they come.
private struct FrameThumbnail: View {
    let model: RunDetailModel
    let frame: RunFrameRef
    @State private var image: Image?

    var body: some View {
        Group {
            if let image {
                image.resizable().scaledToFit()
            } else {
                Rectangle().fill(PsycheColor.muted.opacity(0.15))
                    .overlay(Image(systemName: "photo").foregroundStyle(PsycheColor.muted))
            }
        }
        .frame(width: 128, height: 128 * CGFloat(frame.height) / CGFloat(max(frame.width, 1)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel(String(localized: "Screenshot from this step", bundle: .module))
        .task { await loadImage() }
    }

    private func loadImage() async {
        guard image == nil, let data = try? await model.imageData(for: frame) else { return }
        image = decodedImage(data)
    }
}

/// The screenshot at full size, for the owner to look at. Close returns to the steps.
private struct FrameViewer: View {
    let model: RunDetailModel
    let frame: RunFrameRef
    @Environment(\.dismiss) private var dismiss
    @State private var image: Image?

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                Group {
                    if let image {
                        image.resizable().scaledToFit()
                    } else {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(PsycheMetrics.pagePadding)
            }
            .psycheScreen()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Close", bundle: .module)) { dismiss() }
                }
            }
            .task {
                guard let data = try? await model.imageData(for: frame, size: .full) else { return }
                // A full-size frame is megapixels of decoding: it runs off the main actor, and only the result returns.
                image = await Task.detached(priority: .userInitiated) { DecodedPicture(image: decodedImage(data)) }.value.image
            }
        }
    }
}

/// Carries a decoded picture back from the detached decode. SwiftUI's `Image` is a value built once here and then only drawn.
private struct DecodedPicture: @unchecked Sendable {
    let image: Image?
}

/// The picture from its bytes. Nil when the bytes are not an image this platform can draw.
private func decodedImage(_ data: Data) -> Image? {
    #if canImport(UIKit)
    UIImage(data: data).map { Image(uiImage: $0) }
    #else
    nil
    #endif
}
