import AVFoundation
import Observation
import SwiftUI

/// Camera permission and availability for the pairing scanner.
@MainActor @Observable
final class CameraAccess {
    enum Status { case undetermined, denied, unavailable, ready }

    private(set) var status: Status = .undetermined

    init() { refresh() }

    func refresh() {
        guard AVCaptureDevice.default(for: .video) != nil else {
            status = .unavailable
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: status = .ready
        case .notDetermined: status = .undetermined
        default: status = .denied
        }
    }

    func request() async {
        _ = await AVCaptureDevice.requestAccess(for: .video)
        refresh()
    }
}

#if os(iOS)
import UIKit

/// A live camera preview that reports the first QR code it reads.
struct CameraScanner: UIViewRepresentable {
    let onCode: @MainActor (String) -> Void

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        let controller = context.coordinator.controller
        controller.onCode = onCode
        view.previewLayer.session = controller.session
        view.previewLayer.videoGravity = .resizeAspectFill
        controller.start()
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.controller.onCode = onCode
    }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.controller.stop()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        let controller = CaptureController()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}

/// Owns the capture session. Everything touching it runs on one serial queue.
final class CaptureController: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    nonisolated(unsafe) let session = AVCaptureSession()
    nonisolated(unsafe) var onCode: (@MainActor (String) -> Void)?
    private let queue = DispatchQueue(label: "psyche.pairing.capture")
    private var configured = false
    private var delivered = false

    func start() {
        queue.async { [self] in
            if !configured {
                configured = true
                guard let device = AVCaptureDevice.default(for: .video),
                    let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input)
                else { return }
                session.addInput(input)
                let output = AVCaptureMetadataOutput()
                guard session.canAddOutput(output) else { return }
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: queue)
                output.metadataObjectTypes = [.qr]
            }
            if !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection
    ) {
        guard !delivered,
            let value = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
        else { return }
        delivered = true
        let handler = onCode
        Task { @MainActor in handler?(value) }
        // Scan again if the code is rejected and the screen stays.
        queue.asyncAfter(deadline: .now() + 2) { [self] in delivered = false }
    }
}
#endif
