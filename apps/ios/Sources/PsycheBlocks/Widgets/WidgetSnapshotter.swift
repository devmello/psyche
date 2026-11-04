#if DEBUG && canImport(UIKit)
import PsycheDesign
import PsycheStore
import SwiftUI
import UIKit

/// Renders every widget fixture (light and dark) to PNG files, for checking the renderer when the
/// simulator can't be screenshotted from outside (a system alert on top, say). Debug builds only:
/// `-psycheWidgetSnapshotDir <name>` writes `<fixture>-<light|dark>.png` into the app's Documents/<name>.
/// Each fixture is drawn at the phone width in its own offscreen window at its full height.
@MainActor
enum WidgetSnapshotter {
    static var requestedDirectory: String? { UserDefaults.standard.string(forKey: "psycheWidgetSnapshotDir") }

    static func run(directory name: String, width: CGFloat = 402) async {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let folder = URL.documentsDirectory.appending(path: name, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let backend = FixtureBackend()
        for fixture in WidgetFixture.all {
            for dark in [false, true] {
                let content = VStack(alignment: .leading, spacing: 8) {
                    Text(fixture.name).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                    WidgetView(widgetID: fixture.id, backend: backend, surface: fixture.id.hasPrefix("feed:") ? .feed : .chat)
                }
                .padding(PsycheMetrics.pagePadding)
                .frame(width: width, alignment: .topLeading)
                .background(PsycheColor.paper)
                .environment(\.widgetHandlers, WidgetHandlers(openRoute: { _ in true }, prefillReply: { _ in }))

                let host = UIHostingController(rootView: content)
                host.overrideUserInterfaceStyle = dark ? .dark : .light
                let height = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: width, height: max(200, height))
                window.rootViewController = host
                window.isHidden = false
                // Let the fixture load (latency is zero), images and map tiles arrive, then re-measure.
                try? await Task.sleep(for: .seconds(fixture.id == "wdg_map" ? 4 : 1.2))
                let fitted = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
                window.frame.size.height = max(200, fitted)
                host.view.frame = window.bounds
                host.view.layoutIfNeeded()
                try? await Task.sleep(for: .milliseconds(300))
                let renderer = UIGraphicsImageRenderer(size: window.bounds.size)
                let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                let file = folder.appending(path: "\(fixture.id.replacingOccurrences(of: ":", with: "_"))-\(dark ? "dark" : "light").png")
                try? image.pngData()?.write(to: file)
                window.isHidden = true
            }
        }
        try? "done".write(to: folder.appending(path: "DONE"), atomically: true, encoding: .utf8)
    }
}
#endif
