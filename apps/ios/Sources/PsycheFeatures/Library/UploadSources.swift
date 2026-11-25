#if os(iOS)
import PDFKit
import PhotosUI
import PsycheDesign
import PsycheStore
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

/// The toolbar + menu: where files come from (Photos, Files, the scanner, a voice memo).
struct UploadMenuButton: View {
    let onFiles: ([UploadFile]) -> Void

    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showScanner = false
    @State private var showVoiceMemo = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var problem: String?
    @Environment(Router.self) private var router

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label(String(localized: "Photos", bundle: .module), systemImage: "photo.on.rectangle") }
            Button { showFiles = true } label: { Label(String(localized: "Files", bundle: .module), systemImage: "folder") }
            Button { showScanner = true } label: { Label(String(localized: "Scan document", bundle: .module), systemImage: "doc.viewfinder") }
                .disabled(!VNDocumentCameraViewController.isSupported)
            Button { showVoiceMemo = true } label: { Label(String(localized: "Voice memo", bundle: .module), systemImage: "mic") }
        } label: {
            Label(String(localized: "Add to Library", bundle: .module), systemImage: "plus")
        }
        .accessibilityLabel(String(localized: "Add to Library", bundle: .module))
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 10, matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task { await importPhotos(items) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): importFiles(urls)
            case .failure(let error): problem = error.localizedDescription
            }
        }
        .sheet(isPresented: $showVoiceMemo) {
            // A saved memo opens on its Library page; the Mac has already filed it.
            VoiceMemoSheet { item in
                showVoiceMemo = false
                router.tab = .library
                router.libraryPath = [.file(id: item.id)]
            }
        }
        .fullScreenCover(isPresented: $showScanner) {
            DocumentScanner { pdf in
                showScanner = false
                if let pdf { onFiles([pdf]) }
            }
            .ignoresSafeArea()
        }
        .alert(String(localized: "Couldn't add that", bundle: .module), isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button(String(localized: "OK", bundle: .module), role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        var files: [UploadFile] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? .jpeg
            let ext = type.preferredFilenameExtension ?? "jpg"
            let name = "Photo \(Date.now.formatted(.iso8601.year().month().day().dateSeparator(.dash))) \(files.count + 1).\(ext)"
            files.append(UploadFile(name: name, contentType: type.preferredMIMEType ?? "image/jpeg", data: data))
        }
        if files.isEmpty { problem = String(localized: "Those photos couldn't be read.", bundle: .module) } else { onFiles(files) }
    }

    private func importFiles(_ urls: [URL]) {
        var files: [UploadFile] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            files.append(UploadFile(name: url.lastPathComponent, contentType: mime, data: data))
        }
        if files.isEmpty { problem = String(localized: "Those files couldn't be read.", bundle: .module) } else { onFiles(files) }
    }
}

/// VisionKit's document camera; the pages come back as one PDF.
struct DocumentScanner: UIViewControllerRepresentable {
    let onFinish: (UploadFile?) -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: (UploadFile?) -> Void
        init(onFinish: @escaping (UploadFile?) -> Void) { self.onFinish = onFinish }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onFinish(nil)
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            onFinish(nil)
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let document = PDFDocument()
            for index in 0..<scan.pageCount {
                if let page = PDFPage(image: scan.imageOfPage(at: index)) { document.insert(page, at: document.pageCount) }
            }
            guard let data = document.dataRepresentation() else { return onFinish(nil) }
            let stamp = Date.now.formatted(.iso8601.year().month().day().dateSeparator(.dash))
            onFinish(UploadFile(name: "Scan \(stamp).pdf", contentType: "application/pdf", data: data))
        }
    }
}
#endif
