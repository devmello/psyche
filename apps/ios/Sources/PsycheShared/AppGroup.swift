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

extension AppGroup {
    /// Where the app keeps its small durable files (endpoint, outbox, last-seen state): `<group>/Psyche`,
    /// or Application Support/Psyche where the group is not provisioned (unit tests, unsigned builds).
    public static var dataDirectory: URL {
        let base = containerURL
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Psyche", isDirectory: true)
    }

    /// Creates `directory` if needed and keeps it out of iCloud and device backups: what is in here belongs to
    /// one Gateway pairing on this phone and must not travel to another device or restore after a revoke.
    /// Files in it are protected until first unlock (readable by the extensions after the first unlock).
    public static func prepareDirectory(_ directory: URL) throws {
        var url = directory
        try FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
}
