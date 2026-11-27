import PhotosUI
import PsycheDesign
import PsycheStore
import SwiftUI
import UniformTypeIdentifiers

/// The Liquid Glass composer: a + menu, the text field with dictation, and Send (ink) or Stop. While Psyche
/// is replying, Send queues the message (like Messages), Stop stays, and the queued messages show above
/// the field with a remove action. The glass is chrome; the only ink fill is Send.
struct Composer: View {
    @Bindable var composer: ComposerModel
    let isRunning: Bool
    let canSend: Bool
    var focused: FocusState<Bool>.Binding
    let queue: [QueuedFollowUp]
    let removeQueued: (QueuedFollowUp) -> Void
    let send: () -> Void
    let stop: () -> Void

    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var photoSelection: [PhotosPickerItem] = []
    private let motion = MotionContext()
    @Namespace private var glass
    @ScaledMetric(relativeTo: .body) private var fieldHit: CGFloat = 48
    @ScaledMetric(relativeTo: .body) private var controlHit: CGFloat = 44
    @State private var sendTick = 0

    private var showsStop: Bool { isRunning && composer.trimmedText.isEmpty && composer.attachments.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !queue.isEmpty {
                QueueStrip(items: queue, remove: removeQueued)
                    .transition(motion.transition(.rise))
            }
            if !composer.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(composer.attachments) { attachment in
                            AttachmentChip(attachment: attachment) { composer.remove(attachment) }
                                .transition(motion.transition(.rise))
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            if case .failed(let message) = composer.dictation.state {
                Button { composer.dictation.clearError() } label: {
                    Text(message).font(.footnote).foregroundStyle(PsycheColor.muted)
                        .multilineTextAlignment(.leading)
                        .padding(.horizontal, 16)
                }
                .buttonStyle(.plain)
            }
            GlassEffectContainer(spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    plusMenu
                    field
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        // Chips arriving or leaving, and the bar growing with them. Typing animates nothing.
        .psycheAnimation(.smooth, value: composer.attachments.map(\.id))
        .psycheAnimation(.smooth, value: queue.map(\.id))
        .photosPicker(isPresented: $showPhotos, selection: $photoSelection, maxSelectionCount: 5, matching: .images)
        .onChange(of: photoSelection) { _, items in
            guard !items.isEmpty else { return }
            composer.addPhotos(items)
            photoSelection = []
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) {
            composer.addFiles($0)
        }
        #if canImport(UIKit)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { composer.addCameraImage($0) }.ignoresSafeArea()
        }
        #endif
    }

    private var plusMenu: some View {
        Menu {
            Button { showPhotos = true } label: { Label(String(localized: "Photos", bundle: .module), systemImage: "photo.on.rectangle") }
            Button { showFiles = true } label: { Label(String(localized: "Files", bundle: .module), systemImage: "folder") }
            #if canImport(UIKit)
            if CameraPicker.isAvailable {
                Button { showCamera = true } label: { Label(String(localized: "Camera", bundle: .module), systemImage: "camera") }
            }
            #endif
        } label: {
            Image(systemName: "plus")
                .font(.title3)
                .foregroundStyle(PsycheColor.text)
                .frame(width: fieldHit, height: fieldHit)
                .contentShape(Circle())
        }
        .glassEffect(.regular.interactive(), in: .circle)
        .glassEffectID("plus", in: glass)
        .accessibilityLabel(String(localized: "Add photo or file", bundle: .module))
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 4) {
            TextField(String(localized: "Reply to Psyche", bundle: .module), text: $composer.text, axis: .vertical)
                .font(.callout)
                .lineLimit(1...5)
                .focused(focused)
                .padding(.vertical, 14)
                .padding(.leading, 6)
            dictationButton
            // Stop keeps its place while a reply runs and the reader is typing: a compact one sits by Send.
            if isRunning, !showsStop { stopButton.transition(.opacity) }
            // Send and Stop trade places in one slot with a 100 ms crossfade, so the field never shifts.
            ZStack {
                if showsStop {
                    stopButton.transition(.opacity)
                } else {
                    sendButton.transition(.opacity)
                }
            }
            .psycheFade(PsycheMotion.Duration.micro, value: showsStop)
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(minHeight: fieldHit)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .glassEffectID("field", in: glass)
    }

    private var dictationButton: some View {
        let active = composer.dictation.isActive
        return Button { composer.toggleDictation() } label: {
            Image(systemName: active ? "waveform" : "mic")
                .font(.body)
                .foregroundStyle(active ? PsycheColor.text : PsycheColor.muted)
                .symbolEffect(.variableColor.iterative, isActive: active && !motion.reduced)
                .frame(width: controlHit, height: controlHit)
                .contentShape(Circle())
        }
        .padding(.bottom, 6)
        .accessibilityLabel(active ? String(localized: "Stop dictation", bundle: .module) : String(localized: "Dictate", bundle: .module))
    }

    private var sendButton: some View {
        Button { sendTick += 1; send() } label: {
            Image(systemName: "arrow.up")
                .font(.callout.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: controlHit, height: controlHit)
                .background(PsycheColor.ink, in: Circle())
        }
        .padding(.bottom, 6)
        .disabled(!canSend)
        .opacity(canSend ? 1 : 0.4)
        .sensoryFeedback(.impact, trigger: sendTick)
        .accessibilityLabel(String(localized: "Send", bundle: .module))
    }

    /// Stop is not ink: the screen's one filled control is Send.
    private var stopButton: some View {
        Button(action: stop) {
            Image(systemName: "stop.fill")
                .font(.footnote.weight(.bold))
                .foregroundStyle(PsycheColor.text)
                .frame(width: controlHit, height: controlHit)
                .background(PsycheColor.fill, in: Circle())
        }
        .padding(.bottom, 6)
        .accessibilityLabel(String(localized: "Stop", bundle: .module))
    }
}

/// The messages Psyche will read after its reply, in order. Each can be removed before it starts.
private struct QueueStrip: View {
    let items: [QueuedFollowUp]
    let remove: (QueuedFollowUp) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(String(localized: "Queued", bundle: .module))
                .font(.caption)
                .foregroundStyle(PsycheColor.muted)
                .padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(items) { item in
                        QueuedChip(item: item) { remove(item) }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }
}

private struct QueuedChip: View {
    let item: QueuedFollowUp
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock").font(.caption).foregroundStyle(PsycheColor.muted)
            Text(item.text)
                .font(.footnote)
                .foregroundStyle(PsycheColor.text)
                .lineLimit(1)
                .frame(maxWidth: 200, alignment: .leading)
            Button(action: remove) {
                Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(PsycheColor.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "Remove queued message", bundle: .module))
        }
        .padding(.leading, 10).padding(.trailing, 0)
        .background(PsycheColor.sheet, in: Capsule())
        .overlay(Capsule().strokeBorder(PsycheColor.hairline, lineWidth: 1))
    }
}

private struct AttachmentChip: View {
    let attachment: ComposerAttachment
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            switch attachment.state {
            case .uploading:
                ProgressView().controlSize(.small)
            case .waiting:
                Image(systemName: "clock").font(.caption).foregroundStyle(PsycheColor.muted)
            case .ready:
                Image(systemName: attachment.isImage ? "photo" : "doc").font(.caption).foregroundStyle(PsycheColor.muted)
            case .failed:
                Image(systemName: "exclamationmark.circle").font(.caption).foregroundStyle(PsycheColor.red)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(attachment.name).font(.footnote).foregroundStyle(PsycheColor.text).lineLimit(1)
                if case .failed(let reason) = attachment.state {
                    Text(reason).font(.caption2).foregroundStyle(PsycheColor.muted)
                } else if attachment.state == .waiting {
                    Text(ComposerModel.waitingText).font(.caption2).foregroundStyle(PsycheColor.muted).lineLimit(2)
                }
            }
            .frame(maxWidth: 160, alignment: .leading)
            Button(action: remove) {
                Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(PsycheColor.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "Remove \(attachment.name)", bundle: .module))
        }
        .padding(.leading, 10).padding(.trailing, 0)
        .background(PsycheColor.sheet, in: Capsule())
        .overlay(Capsule().strokeBorder(PsycheColor.hairline, lineWidth: 1))
    }
}
