#if canImport(UIKit)
import SwiftUI
import UIKit

/// The system camera, for "Camera" in the + menu. Returns JPEG data.
struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    /// The captured frame handed to the encoder task. UIImage is only read there, never mutated.
    private struct PickedCapture: @unchecked Sendable {
        let image: UIImage
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            // The JPEG encode of a full-resolution capture (about 12 MP) runs off the main thread; the picker closes at once.
            if let image = info[.originalImage] as? UIImage {
                let picked = PickedCapture(image: image)
                let onCapture = parent.onCapture
                Task { @MainActor in
                    let data = await Task.detached(priority: .userInitiated) { picked.image.jpegData(compressionQuality: 0.85) }.value
                    if let data { onCapture(data) }
                }
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

#endif
