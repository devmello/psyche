import PsycheShared
import UIKit

/// Share sheet to the outbox: library.upload and chat.send (docs/design/ios-app-2026.md §2). I6 builds
/// it; today it completes at once.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        extensionContext?.completeRequest(returningItems: nil)
    }
}
