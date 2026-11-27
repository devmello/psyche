import Foundation
import Observation
import PhotosUI
import PsycheClient
import PsycheStore
import SwiftUI
import UniformTypeIdentifiers

/// A file chip in the composer, from pick to upload.
struct ComposerAttachment: Identifiable, Equatable {
    enum State: Equatable {
        case uploading
        /// The Mac isn't reachable: the file is kept and uploads when it is.
        case waiting
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
    private let payloads: WaitingPayloadStore
    private var textBeforeDictation = ""
    private static let maxBytes = 25 * 1024 * 1024
    /// Set once per launch: the first composer removes files an earlier launch left, before any composer saves one.
    private static var sweptLeftovers = false

    init(threadID: String, store: any PsycheBackend, payloads: WaitingPayloadStore = .standard) {
        self.threadID = threadID
        self.store = store
        self.payloads = payloads
        if !Self.sweptLeftovers {
            Self.sweptLeftovers = true
            payloads.sweepLeftovers()
        }
    }

    /// Uploading, or waiting for the Mac: Send holds until the file can go with the message.
    var isUploading: Bool { attachments.contains { $0.state == .uploading || $0.state == .waiting } }
    /// What a waiting file's chip says.
    static let waitingText = String(localized: "This file will upload when your Mac is reachable", bundle: .module)
    /// Where the bytes of each file waiting for the Mac are kept (a temp file, not memory); they upload again from `retryWaiting()`.
    private var waitingFiles: [ComposerAttachment.ID: URL] = [:]
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

    /// Clears the text after a message sent while Psyche replies was accepted. Text typed since then stays.
    func textWasSent(_ sent: String) {
        guard trimmedText == sent else { return }
        dictation.stop()
        text = ""
    }

    /// Takes the message out of the composer; the thread model sends it.
    func takeMessage() -> (text: String, attachments: [AttachmentRef]) {
        dictation.stop()
        let message = (trimmedText, readyAttachments)
        text = ""
        attachments.removeAll { if case .ready = $0.state { true } else { false } }
        return message
    }

    func remove(_ attachment: ComposerAttachment) {
        discardWaiting(attachment.id)
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
                    fail(placeholder, String(localized: "Couldn't read this photo", bundle: .module))
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
                    fail(placeholder, String(localized: "Couldn't read this file", bundle: .module))
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
        guard data.count <= Self.maxBytes else { return fail(id, String(localized: "Over 25 MB", bundle: .module)) }
        do {
            let item = try await store.upload(
                UploadFile(name: attachment.name, contentType: attachment.contentType, data: data, threadID: threadID))
            discardWaiting(id)
            update(id, .ready(libraryID: item.id))
        } catch BackendError.unreachable {
            // The bytes go to a temp file while the Mac is away; `data` is released when this call returns.
            do {
                waitingFiles[id] = try payloads.save(data)
            } catch {
                return fail(id, String(localized: "Upload failed", bundle: .module))
            }
            update(id, .waiting)
            if connectionIsLive, retriedWhileLive.insert(id).inserted { retryWaiting() }
        } catch {
            discardWaiting(id)
            fail(id, (error as? LocalizedError)?.errorDescription ?? String(localized: "Upload failed", bundle: .module))
        }
    }

    /// True once the connection is live. A file that fails as unreachable after that point (the connection
    /// went live while its upload was in flight) retries once at once instead of waiting for a change that
    /// already happened.
    private var connectionIsLive = false
    private var retriedWhileLive: Set<ComposerAttachment.ID> = []

    /// The connection changed. Files wait only for `.live`: `.connecting` counts as able to answer, so a file
    /// attached while connecting fails as unreachable, and nothing else would send it again.
    func connectionChanged(to state: ConnectionState) {
        connectionIsLive = state == .live
        if connectionIsLive { retryWaiting() }
    }

    /// Uploads the files that waited for the Mac. Call when the connection comes back.
    func retryWaiting() {
        for (id, url) in waitingFiles where attachments.first(where: { $0.id == id })?.state == .waiting {
            guard let data = payloads.load(url) else {
                discardWaiting(id)
                fail(id, String(localized: "Upload failed", bundle: .module))
                continue
            }
            // The file goes before the retry: a retry that is still unreachable saves it again.
            discardWaiting(id)
            update(id, .uploading)
            Task { await upload(id, data: data) }
        }
    }

    private func fail(_ id: ComposerAttachment.ID, _ reason: String) { update(id, .failed(reason)) }

    /// Deletes a waiting file and forgets it, once the file is sent, cancelled or failed.
    private func discardWaiting(_ id: ComposerAttachment.ID) {
        guard let url = waitingFiles.removeValue(forKey: id) else { return }
        payloads.delete(url)
    }

    private func update(_ id: ComposerAttachment.ID, _ state: ComposerAttachment.State) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[index].state = state
    }

    private static func timestamp() -> String {
        Date.now.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour().minute())
            .replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
    }
}
