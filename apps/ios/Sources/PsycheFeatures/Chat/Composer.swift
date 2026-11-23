import PhotosUI
import PsycheDesign
import SwiftUI
import UniformTypeIdentifiers

/// The Liquid Glass composer: a + menu, the text field with dictation, and Send (ink) or Stop. The glass
/// is chrome; the only ink fill is Send.
struct Composer: View {
    @Bindable var composer: ComposerModel
    let isRunning: Bool
    let canSend: Bool
    var focused: FocusState<Bool>.Binding
    let send: () -> Void
    let stop: () -> Void

    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var photoSelection: [PhotosPickerItem] = []
    private let motion = MotionContext()
    @Namespace private var glass

    private var showsStop: Bool { isRunning && composer.trimmedText.isEmpty && composer.attachments.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
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
                .font(.system(size: 19, weight: .regular))
                .foregroundStyle(PsycheColor.text)
                .frame(width: 48, height: 48)
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
        .frame(minHeight: 48)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .glassEffectID("field", in: glass)
    }

    private var dictationButton: some View {
        let active = composer.dictation.isActive
        return Button { composer.toggleDictation() } label: {
            Image(systemName: active ? "waveform" : "mic")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(active ? PsycheColor.text : PsycheColor.muted)
                .symbolEffect(.variableColor.iterative, isActive: active && !motion.reduced)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .padding(.bottom, 6)
        .accessibilityLabel(active ? String(localized: "Stop dictation", bundle: .module) : String(localized: "Dictate", bundle: .module))
    }

    private var sendButton: some View {
        Button(action: send) {
            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(PsycheColor.ink, in: Circle())
        }
        .padding(.bottom, 6)
        .disabled(!canSend)
        .opacity(canSend ? 1 : 0.4)
        .accessibilityLabel(String(localized: "Send", bundle: .module))
    }

    /// Stop is not ink: the screen's one filled control is Send.
    private var stopButton: some View {
        Button(action: stop) {
            Image(systemName: "stop.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(PsycheColor.text)
                .frame(width: 36, height: 36)
                .background(PsycheColor.fill, in: Circle())
        }
        .padding(.bottom, 6)
        .accessibilityLabel(String(localized: "Stop", bundle: .module))
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
                    .frame(width: 22, height: 22)
            }
            .accessibilityLabel(String(localized: "Remove \(attachment.name)", bundle: .module))
        }
        .padding(.leading, 10).padding(.trailing, 4).padding(.vertical, 4)
        .background(PsycheColor.sheet, in: Capsule())
        .overlay(Capsule().strokeBorder(PsycheColor.hairline, lineWidth: 1))
    }
}
