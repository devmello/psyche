#if os(iOS)
import PsycheDesign
import PsycheStore
import SwiftUI

/// Record a voice memo into the Library. Elapsed time while recording, Stop saves it (the Mac transcribes and files
/// it), Cancel discards it. Leaving the screen, or the app, discards too: no microphone runs unseen.
struct VoiceMemoSheet: View {
    @Environment(\.backend) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: VoiceMemoModel?
    /// Called with the saved item; the sheet has already closed itself.
    let onOpen: (PsycheStore.LibraryItem) -> Void

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    VoiceMemoPanel(model: model, onOpen: { item in
                        onOpen(item)
                        dismiss()
                    })
                } else {
                    Color.clear
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(String(localized: "Voice memo", bundle: .module))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(cancelTitle) {
                        Task {
                            await model?.cancel()
                            dismiss()
                        }
                    }
                }
            }
        }
        .task {
            if model == nil {
                // The demo scenario records silence; a real phone asks for the microphone when the owner taps Start.
                let recorder: any VoiceMemoRecording = store is FixtureBackend ? FixtureVoiceMemoRecorder() : LiveVoiceMemoRecorder()
                model = VoiceMemoModel(backend: store, recorder: recorder)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await model?.cancel() } }
        }
        .onDisappear { Task { await model?.cancel() } }
    }

    private var cancelTitle: String {
        if case .saved = model?.phase { return String(localized: "Done", bundle: .module) }
        return String(localized: "Cancel", bundle: .module)
    }
}

private struct VoiceMemoPanel: View {
    let model: VoiceMemoModel
    let onOpen: (PsycheStore.LibraryItem) -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 0)
            switch model.phase {
            case .idle:
                Text("Record a note for your Library. Your Mac transcribes it.", bundle: .module)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                startButton(String(localized: "Start recording", bundle: .module))
            case .failed(let message):
                Text(message)
                    .foregroundStyle(PsycheColor.red)
                    .multilineTextAlignment(.center)
                startButton(String(localized: "Try again", bundle: .module))
            case .preparing:
                ProgressView()
                Text("Starting the recording…", bundle: .module)
                    .foregroundStyle(.secondary)
            case .recording(let since):
                Text(since, style: .timer)
                    .font(.system(size: 48, weight: .semibold).monospacedDigit())
                    .accessibilityLabel(String(localized: "Elapsed time", bundle: .module))
                Text("Recording", bundle: .module)
                    .foregroundStyle(.secondary)
                Button {
                    Task { await model.stop() }
                } label: {
                    Label(String(localized: "Stop and save", bundle: .module), systemImage: "stop.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(PsycheColor.ink)
                .controlSize(.large)
                Text("Cancel discards the memo.", bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .saving:
                ProgressView()
                Text("Saving…", bundle: .module)
                    .foregroundStyle(.secondary)
            case .saved(let saved):
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(PsycheColor.ink)
                Text("Saved to Library", bundle: .module)
                    .font(.headline)
                Text(saved.item.title)
                    .foregroundStyle(.secondary)
                if !saved.transcript.isEmpty {
                    Text(saved.transcript)
                        .textSelection(.enabled)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                Button {
                    onOpen(saved.item)
                } label: {
                    Text("Open in Library", bundle: .module).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(PsycheColor.ink)
                .controlSize(.large)
            }
            Spacer(minLength: 0)
        }
    }

    private func startButton(_ title: String) -> some View {
        Button {
            Task { await model.start() }
        } label: {
            Label(title, systemImage: "mic.circle.fill").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(PsycheColor.ink)
        .controlSize(.large)
    }
}
#endif
