#if os(iOS)
import PDFKit
import PhotosUI
import PsycheDesign
import PsycheStore
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

/// The + button: a floating glass control (chrome, so it gets Liquid Glass) with a menu of where files
/// come from. This is the Library screen's one ink fill.
struct UploadMenuButton: View {
    let onFiles: ([UploadFile]) -> Void

    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showScanner = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var problem: String?

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
            Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
            Button { showScanner = true } label: { Label("Scan document", systemImage: "doc.viewfinder") }
                .disabled(!VNDocumentCameraViewController.isSupported)
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .glassEffect(.regular.tint(PsycheColor.ink).interactive(), in: .circle)
        }
        .accessibilityLabel("Add to Library")
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
        .fullScreenCover(isPresented: $showScanner) {
            DocumentScanner { pdf in
                showScanner = false
                if let pdf { onFiles([pdf]) }
            }
            .ignoresSafeArea()
        }
        .alert("Couldn't add that", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
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
        if files.isEmpty { problem = "Those photos couldn't be read." } else { onFiles(files) }
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
        if files.isEmpty { problem = "Those files couldn't be read." } else { onFiles(files) }
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
