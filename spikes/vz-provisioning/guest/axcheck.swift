// Prints whether the responsible process holds Accessibility and Screen Recording, and tries
// one real ScreenCaptureKit capture. Run as a child of the node agent, TCC attributes the
// check to the agent's responsible binary (node), which is what a pre-grant has to target.
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// Optional first argument: write the capture as PNG to this path.
let outPath = CommandLine.arguments.dropFirst().first

let ax = AXIsProcessTrusted()
let screen = CGPreflightScreenCaptureAccess()
var capture = "skipped"
let sem = DispatchSemaphore(value: 0)
Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        if let display = content.displays.first {
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.width = display.width
            cfg.height = display.height
            let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            capture = "\(img.width)x\(img.height)"
            if let outPath, let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL,
                                                                     UTType.png.identifier as CFString, 1, nil) {
                CGImageDestinationAddImage(dest, img, nil)
                capture += CGImageDestinationFinalize(dest) ? " saved" : " save-failed"
            }
        } else {
            capture = "no display"
        }
    } catch {
        capture = "error: \(error.localizedDescription)"
    }
    sem.signal()
}
_ = sem.wait(timeout: .now() + 10)
let esc = capture.replacingOccurrences(of: "\"", with: "'")
print("{\"accessibility\":\(ax),\"screenRecording\":\(screen),\"capture\":\"\(esc)\"}")
