import ImageIO
import PsycheShared
import UIKit
import UniformTypeIdentifiers

/// What the host app handed the extension, copied into this extension's temp folder.
struct SharedPayload {
    var files: [(url: URL, name: String, contentType: String)] = []
    /// Shared text and links, joined; sent inside the message.
    var text = ""
    var thumbnail: UIImage?

    var isEmpty: Bool { files.isEmpty && text.isEmpty }

    /// "lease.pdf", "3 photos", "A link", "Some text".
    var summary: String {
        switch (files.count, text.isEmpty) {
        case (0, false): URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines))?.host() != nil ? "A link" : "Some text"
        case (1, _): files[0].name
        case (let n, _): "\(n) files"
        }
    }

    var detail: String? {
        if files.isEmpty { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        return files.count > 1 ? files.map(\.name).joined(separator: ", ") : nil
    }
}

/// Reads the extension's input items: files, images, links and text. The content is untrusted; nothing
/// here opens or interprets it beyond making a small preview.
@MainActor
enum ShareItemLoader {
    static func load(from items: [NSExtensionItem]) async -> SharedPayload {
        var payload = SharedPayload()
        let scratch = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        var texts: [String] = []
        for item in items {
            for provider in item.attachments ?? [] {
                if let file = await copyFile(from: provider, into: scratch) {
                    payload.files.append(file)
                } else if let text = await readText(from: provider) {
                    texts.append(text)
                }
            }
            // A page shared from Safari carries a title as well as the link.
            if payload.files.isEmpty, let title = item.attributedContentText?.string, !title.isEmpty, !texts.contains(title),
                texts.contains(where: { URL(string: $0)?.host() != nil })
            {
                texts.insert(title, at: 0)
            }
        }
        payload.text = texts.joined(separator: "\n")
        if let image = payload.files.first(where: { $0.contentType.hasPrefix("image/") }) {
            payload.thumbnail = downsample(image.url, maxPixel: 360)
        }
        return payload
    }

    // MARK: Files

    private static func copyFile(from provider: NSItemProvider, into scratch: URL) async -> (url: URL, name: String, contentType: String)? {
        let types = provider.registeredContentTypes
        let isLink = types.contains { $0.conforms(to: .url) && !$0.conforms(to: .fileURL) }
        let type: UTType?
        if let image = types.first(where: { $0.conforms(to: .image) }) {
            type = image
        } else if types.contains(where: { $0.conforms(to: .fileURL) }) {
            return await copyFileURL(from: provider, into: scratch)
        } else if isLink || types.contains(where: { $0.conforms(to: .plainText) }) {
            return nil
        } else {
            type = types.first { $0.conforms(to: .data) || $0.conforms(to: .content) }
        }
        guard let type else { return nil }
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                // The system deletes `url` when this handler returns, so the copy happens here.
                guard let url else { return continuation.resume(returning: nil) }
                let name = fileName(suggested: suggested, original: url, type: type)
                let destination = uniqueURL(in: scratch, name: name)
                do {
                    try FileManager.default.copyItem(at: url, to: destination)
                    continuation.resume(returning: (destination, destination.lastPathComponent, type.preferredMIMEType ?? "application/octet-stream"))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private static func copyFileURL(from provider: NSItemProvider, into scratch: URL) async -> (url: URL, name: String, contentType: String)? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                guard let url = (item as? URL) ?? (item as? NSURL) as URL? ?? (item as? Data).flatMap({ URL(dataRepresentation: $0, relativeTo: nil) }),
                    url.isFileURL
                else { return continuation.resume(returning: nil) }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let destination = uniqueURL(in: scratch, name: url.lastPathComponent)
                do {
                    try FileManager.default.copyItem(at: url, to: destination)
                    let type = UTType(filenameExtension: url.pathExtension)
                    continuation.resume(returning: (destination, destination.lastPathComponent, type?.preferredMIMEType ?? "application/octet-stream"))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private static func fileName(suggested: String?, original: URL, type: UTType) -> String {
        let ext = original.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : original.pathExtension
        let base = (suggested.map { ($0 as NSString).deletingPathExtension }).flatMap { $0.isEmpty ? nil : $0 }
            ?? (original.deletingPathExtension().lastPathComponent)
        return ext.isEmpty ? base : "\(base).\(ext)"
    }

    private static func uniqueURL(in folder: URL, name: String) -> URL {
        var url = folder.appending(path: name)
        var n = 1
        while FileManager.default.fileExists(atPath: url.path) {
            n += 1
            url = folder.appending(path: "\((name as NSString).deletingPathExtension) \(n).\((name as NSString).pathExtension)")
        }
        return url
    }

    // MARK: Text and links

    private static func readText(from provider: NSItemProvider) async -> String? {
        let types = provider.registeredContentTypes
        let identifier: String
        if types.contains(where: { $0.conforms(to: .url) }) {
            identifier = UTType.url.identifier
        } else if types.contains(where: { $0.conforms(to: .plainText) }) {
            identifier = UTType.plainText.identifier
        } else {
            return nil
        }
        return await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: identifier) { item, _ in
                switch item {
                case let url as URL: continuation.resume(returning: url.absoluteString)
                case let text as String: continuation.resume(returning: text)
                case let data as Data: continuation.resume(returning: String(data: data, encoding: .utf8))
                default: continuation.resume(returning: nil)
                }
            }
        }
    }

    // MARK: Preview

    /// A small preview without decoding the full image (extensions have a tight memory limit).
    private static func downsample(_ url: URL, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map(UIImage.init(cgImage:))
    }
}
