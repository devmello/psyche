import PsycheDesign
import PsycheShared
import SwiftUI

/// The sheet the share extension shows: what's being shared, where it goes, an optional note, and Send.
/// Send writes to the app-group inbox and closes; the app uploads and sends the next time it is open.
struct ShareComposeView: View {
    let payload: SharedPayload
    let recents: [ShareThreadChoice]
    let onCancel: () -> Void
    let onDone: () -> Void

    @State private var destination: ShareDestination = .newChat
    @State private var note = ""
    @State private var problem: String?
    @FocusState private var noteFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                    preview
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader("Send to")
                        destinations
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader("Note")
                        TextField("Add a note (optional)", text: $note, axis: .vertical)
                            .lineLimit(1...5)
                            .focused($noteFocused)
                            .padding(PsycheMetrics.rowPadding)
                            .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous)
                                    .strokeBorder(PsycheColor.hairline))
                    }
                    if let problem {
                        Text(problem).font(.footnote).foregroundStyle(PsycheColor.red)
                    }
                    Button("Send", action: send)
                        .buttonStyle(.psycheInk)
                        .disabled(payload.isEmpty && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    EvidenceLine(["Shared content is untrusted", "Psyche reads it with care"])
                }
                .padding(PsycheMetrics.pagePadding)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(PsycheColor.paper.ignoresSafeArea())
            .navigationTitle("Send to Psyche")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
            }
        }
        .tint(PsycheColor.inkText)
    }

    private var preview: some View {
        PaperCard(padding: 12) {
            HStack(spacing: 12) {
                Group {
                    if let image = payload.thumbnail {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Image(systemName: payload.files.isEmpty ? "text.alignleft" : "doc")
                            .font(.title3).foregroundStyle(PsycheColor.muted)
                    }
                }
                .frame(width: 48, height: 60)
                .background(PsycheColor.fill)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(payload.summary.isEmpty ? "Nothing to share" : payload.summary)
                        .font(.psycheRow.weight(.semibold)).foregroundStyle(PsycheColor.text).lineLimit(2)
                    if let detail = payload.detail {
                        Text(detail).font(.footnote).foregroundStyle(PsycheColor.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var destinations: some View {
        PaperCard {
            VStack(spacing: 0) {
                destinationRow("New chat", systemImage: "square.and.pencil", choice: .newChat)
                ForEach(recents) { thread in
                    HairlineDivider()
                    destinationRow(thread.title, systemImage: "bubble.left", choice: .thread(id: thread.id))
                }
            }
        }
    }

    private func destinationRow(_ title: String, systemImage: String, choice: ShareDestination) -> some View {
        Button {
            destination = choice
        } label: {
            HStack(spacing: 12) {
                Image(systemName: systemImage).foregroundStyle(PsycheColor.muted).frame(width: 22)
                Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text).lineLimit(1)
                Spacer(minLength: 8)
                if destination == choice {
                    Image(systemName: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.inkText)
                }
            }
            .padding(PsycheMetrics.rowPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(destination == choice ? .isSelected : [])
    }

    private func send() {
        guard let inbox = ShareInbox.shared else {
            problem = "Psyche isn't set up to receive shares in this build."
            return
        }
        do {
            try inbox.enqueue(ShareDraft(destination: destination, note: note, text: payload.text, files: payload.files))
            onDone()
        } catch {
            problem = "Couldn't save that to send. Try again."
        }
    }
}
