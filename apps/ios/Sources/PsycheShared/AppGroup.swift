import Foundation

/// The app group the app and its extensions share (cache, snapshot, outbox files; docs/design/ios-app-2026.md §2).
/// The identifier is `group.<bundle id>`; project.yml writes it into every target's Info.plist as
/// `PsycheAppGroup`, so the owner's bundle id (Config/Owner.xcconfig) is the only place it is set.
public enum AppGroup {
    public static let fallbackIdentifier = "group.com.psyche.ios"

    public static var identifier: String {
        (Bundle.main.object(forInfoDictionaryKey: "PsycheAppGroup") as? String) ?? fallbackIdentifier
    }

    /// The shared container, or nil where the group is not provisioned (unit tests, unsigned builds).
    public static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }
}
