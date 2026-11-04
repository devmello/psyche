import Foundation
import Observation
import PhotosUI
import PsycheStore
import SwiftUI
import UniformTypeIdentifiers

/// A file chip in the composer, from pick to upload.
struct ComposerAttachment: Identifiable, Equatable {
    enum State: Equatable {
        case uploading
        case ready(libraryID: String)
        case failed(String)
    }

    let id = UUID()
    var name: String
    var contentType: String
    var state: State

    var fileType: String { (name as NSString).pathExtension.lowercased() }
    var isImage: Bool { contentType.hasPrefix("image/") }
}

/// The composer's text, attachments and dictation for one thread. Files upload as soon as they are
/// picked (through `LibraryBackend.upload`), so Send only carries ids.
@MainActor @Observable
final class ComposerModel {
    var text = ""
    private(set) var attachments: [ComposerAttachment] = []
    let dictation = Dictation()
    private let store: any PsycheBackend
    private let threadID: String
    private var textBeforeDictation = ""
    private static let maxBytes = 25 * 1024 * 1024

    init(threadID: String, store: any PsycheBackend) {
        self.threadID = threadID
        self.store = store
    }

    var isUploading: Bool { attachments.contains { $0.state == .uploading } }
    var hasFailedUpload: Bool {
        attachments.contains { if case .failed = $0.state { true } else { false } }
    }
    var readyAttachments: [AttachmentRef] {
        attachments.compactMap {
            if case .ready(let id) = $0.state { AttachmentRef(id: id, name: $0.name, fileType: $0.fileType) } else { nil }
        }
    }
    var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Send is on when there is something to send and nothing is still uploading.
    var canSend: Bool { (!trimmedText.isEmpty || !readyAttachments.isEmpty) && !isUploading }

    /// Takes the message out of the composer; the thread model sends it.
    func takeMessage() -> (text: String, attachments: [AttachmentRef]) {
        dictation.stop()
        let message = (trimmedText, readyAttachments)
        text = ""
        attachments.removeAll { if case .ready = $0.state { true } else { false } }
        return message
    }

    func remove(_ attachment: ComposerAttachment) {
        attachments.removeAll { $0.id == attachment.id }
    }

    // MARK: Dictation

    func toggleDictation() {
        textBeforeDictation = text.isEmpty || text.hasSuffix(" ") ? text : text + " "
        dictation.toggle { [weak self] transcript in
            guard let self else { return }
            self.text = self.textBeforeDictation + transcript
        }
    }

    // MARK: Attachments

    func addPhotos(_ items: [PhotosPickerItem]) {
        for item in items {
            let type = item.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
            let name = "Photo \(Self.timestamp()).\(type.preferredFilenameExtension ?? "jpg")"
            let placeholder = begin(name: name, contentType: type.preferredMIMEType ?? "image/jpeg")
            Task {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw CocoaError(.fileReadUnknown) }
                    await upload(placeholder, data: data)
                } catch {
                    fail(placeholder, "Couldn't read this photo")
                }
            }
        }
    }

    func addFiles(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        for url in urls {
            let type = UTType(filenameExtension: url.pathExtension)
            let placeholder = begin(name: url.lastPathComponent, contentType: type?.preferredMIMEType ?? "application/octet-stream")
            Task {
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                do {
                    let data = try Data(contentsOf: url, options: .mappedIfSafe)
                    await upload(placeholder, data: data)
                } catch {
                    fail(placeholder, "Couldn't read this file")
                }
            }
        }
    }

    func addCameraImage(_ data: Data) {
        let placeholder = begin(name: "Camera \(Self.timestamp()).jpg", contentType: "image/jpeg")
        Task { await upload(placeholder, data: data) }
    }

    private func begin(name: String, contentType: String) -> ComposerAttachment.ID {
        let attachment = ComposerAttachment(name: name, contentType: contentType, state: .uploading)
        attachments.append(attachment)
        return attachment.id
    }

    private func upload(_ id: ComposerAttachment.ID, data: Data) async {
        guard let attachment = attachments.first(where: { $0.id == id }) else { return }
        guard data.count <= Self.maxBytes else { return fail(id, "Over 25 MB") }
        do {
            let item = try await store.upload(
                UploadFile(name: attachment.name, contentType: attachment.contentType, data: data, threadID: threadID))
            update(id, .ready(libraryID: item.id))
        } catch {
            fail(id, (error as? LocalizedError)?.errorDescription ?? "Upload failed")
        }
    }

    private func fail(_ id: ComposerAttachment.ID, _ reason: String) { update(id, .failed(reason)) }

    private func update(_ id: ComposerAttachment.ID, _ state: ComposerAttachment.State) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[index].state = state
    }

    private static func timestamp() -> String {
        Date.now.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour().minute())
            .replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
    }
}
