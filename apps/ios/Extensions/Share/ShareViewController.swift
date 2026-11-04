import PsycheShared
import SwiftUI
import UIKit

/// Share sheet to the inbox: shows the compose sheet, writes to the app-group `ShareInbox` and closes. The
/// app runs `library.upload` and `chat.send` when it next opens (docs/design/ios-app-2026.md §2).
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        Task { @MainActor in
            let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
            let payload = await ShareItemLoader.load(from: items)
            let recents = ShareInbox.shared?.recents() ?? []
            let host = UIHostingController(
                rootView: ShareComposeView(
                    payload: payload, recents: recents,
                    onCancel: { [weak self] in self?.cancel() },
                    onDone: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }))
            addChild(host)
            host.view.frame = view.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(host.view)
            host.didMove(toParent: self)
        }
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }
}
