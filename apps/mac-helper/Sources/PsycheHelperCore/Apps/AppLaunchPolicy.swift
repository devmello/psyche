import Foundation
import PsycheProtocol

/// Which installed bundle `apps.open` may launch, and which documents it may hand to an app
/// (security §12). Pure rules over paths and Info.plist values: the live LaunchServices, file
/// and code-signing lookups are passed in, so tests never register or launch anything.
public enum AppLaunchPolicy {
    /// The folders an app is launched from. `~/Applications` stays one, but no agent write ever
    /// reaches it (the Gateway refuses it as a share and as a write target).
    public static func appFolders(home: String) -> [String] {
        ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", home + "/Applications"]
    }

    /// Where Apple's own apps live. A `com.apple.*` id from anywhere else is a lookalike.
    static let appleFolders = ["/System/", "/Applications/"]

    /// The lookups `resolve` needs, injected so tests use fakes.
    public struct Lookups: Sendable {
        /// Every bundle LaunchServices knows for an id (`urlsForApplications(withBundleIdentifier:)`).
        public var candidates: @Sendable (String) -> [URL]
        /// The bundle's Info.plist (`Contents/Info.plist`), read fresh.
        public var info: @Sendable (URL) -> [String: Any]?
        /// Whether the bundle exists on disk as a directory.
        public var exists: @Sendable (URL) -> Bool
        /// A read-only static signature check against Apple's anchor (`SecStaticCodeCheckValidity`).
        public var appleSigned: @Sendable (URL) -> Bool

        public init(candidates: @escaping @Sendable (String) -> [URL], info: @escaping @Sendable (URL) -> [String: Any]?,
                    exists: @escaping @Sendable (URL) -> Bool, appleSigned: @escaping @Sendable (URL) -> Bool) {
            self.candidates = candidates
            self.info = info
            self.exists = exists
            self.appleSigned = appleSigned
        }
    }

    /// One spelling per place: symlinks resolved, `/System/Volumes/Data` (the firmlinked data
    /// volume) dropped, no trailing slash.
    public static func canonical(_ url: URL) -> String {
        var p = url.standardizedFileURL.resolvingSymlinksInPath().path
        if p.hasPrefix("/System/Volumes/Data/") { p = String(p.dropFirst("/System/Volumes/Data".count)) }
        while p.count > 1, p.hasSuffix("/") { p.removeLast() }
        return p
    }

    /// The one bundle `bundleId` opens. Refuses an id no bundle has (`app_not_found`), an id two
    /// or more bundles on disk claim (`app_ambiguous`: LaunchServices would pick by version, so a
    /// lookalike could win), and a bundle that fails `check`.
    public static func resolve(bundleId: String, home: String, lookups: Lookups) throws -> URL {
        var seen: [String] = []
        for url in lookups.candidates(bundleId) where lookups.exists(url) {
            let path = canonical(url)
            if !seen.contains(path) { seen.append(path) }
        }
        guard let first = seen.first else {
            throw CapabilityError(.notFound, reason: "app_not_found", "No installed app matches \(bundleId)")
        }
        if seen.count > 1 {
            throw CapabilityError(
                .policyDenied, reason: "app_ambiguous",
                "More than one app on this Mac says it is \(bundleId), so Psyche does not open it. Remove the copy you do not use.",
                details: ["app": .string(bundleId), "paths": .array(seen.prefix(8).map { .string($0) })]
            )
        }
        let url = URL(fileURLWithPath: first)
        try check(url, requestedId: bundleId, home: home, lookups: lookups)
        return url
    }

    /// The rules every bundle passes before it is launched, however it was found:
    /// - it sits directly in an Applications folder (`/Applications/X.app`, `…/Utilities/X.app`),
    ///   never inside another app's bundle;
    /// - its own Info.plist names the requested id, and its executable inside the bundle
    ///   (`CFBundleExecutable` is a plain name, never `../../bin/bash`);
    /// - a `com.apple.*` id lives in `/System` or `/Applications` and carries Apple's signature.
    public static func check(_ url: URL, requestedId: String?, home: String, lookups: Lookups) throws {
        let path = canonical(url)
        guard appFolders(home: home).contains(where: { path.hasPrefix($0 + "/") }) else {
            throw CapabilityError(.policyDenied, reason: "app_outside_applications", "Only apps installed in an Applications folder can be opened")
        }
        if nestedInBundle(path) {
            throw CapabilityError(.policyDenied, reason: "app_nested", "Psyche does not open an app from inside another app's bundle")
        }
        let info = lookups.info(url)
        let own = info?["CFBundleIdentifier"] as? String
        if let requestedId, own?.lowercased() != requestedId.lowercased() {
            throw CapabilityError(.policyDenied, reason: "app_id_mismatch", "The app found for \(requestedId) says it is \(own ?? "nothing")")
        }
        if let exe = info?["CFBundleExecutable"] as? String, exe.contains("/") || exe == ".." || exe == "." || exe.isEmpty {
            throw CapabilityError(.policyDenied, reason: "app_executable_outside", "\(own ?? path) names an executable outside its own bundle")
        }
        if let id = own ?? requestedId, id.lowercased().hasPrefix("com.apple.") {
            guard appleFolders.contains(where: { path.hasPrefix($0) }), lookups.appleSigned(url) else {
                throw CapabilityError(.policyDenied, reason: "apple_id_unsigned",
                                      "\(id) is an Apple app id, but this copy is not Apple's (\(path))")
            }
        }
    }

    /// Whether a bundle path lies inside another bundle: any folder above the last one is itself
    /// an app or a bundle (`/Applications/X.app/Contents/Helpers/Y.app`).
    public static func nestedInBundle(_ path: String) -> Bool {
        let parts = path.split(separator: "/").map(String.init)
        return parts.dropLast().contains { part in
            let ext = (part as NSString).pathExtension.lowercased()
            return ["app", "bundle", "framework", "plugin", "appex", "xpc"].contains(ext)
        }
    }

    // MARK: Documents

    /// Document types that run code, install something or open another location when opened.
    /// Kept in step with the Gateway's `EXECUTABLE_EXTENSIONS` (apps/gateway script-guard.ts).
    public static let executableExtensions: Set<String> = [
        "app", "command", "tool", "sh", "zsh", "bash", "scpt", "scptd", "applescript", "workflow", "terminal", "shortcut",
        "pkg", "mpkg", "dmg", "jar", "py", "rb", "pl", "term", "webloc", "inetloc", "fileloc", "pyw", "pyc", "php", "csh",
        "tcsh", "ksh", "fish", "prefpane", "saver", "mobileconfig", "action",
    ]

    /// Content types whose items run code or open somewhere else (each also matches what
    /// conforms to it, checked by the caller with `UTType.conforms`).
    public static let executableTypes: [String] = [
        "public.executable", "public.unix-executable", "com.apple.application", "com.apple.application-bundle",
        "com.apple.application-file", "com.apple.bundle", "com.apple.plugin", "public.script", "public.shell-script",
        "com.apple.applescript.script", "com.apple.applescript.script-bundle", "com.apple.applescript.text",
        "com.apple.automator-workflow", "com.apple.automator-action", "com.apple.terminal.shell-script",
        "com.apple.terminal.session", "com.apple.web-internet-location", "com.apple.internet-location",
        "com.apple.inetloc", "com.apple.file-location", "com.apple.installer-package-archive", "com.apple.installer-package",
        "com.apple.disk-image", "com.apple.systempreference.prefpane", "com.apple.mobileconfig", "com.apple.shortcut",
        "com.apple.shortcuts.shortcut", "com.sun.java-archive",
    ]

    /// Packages that are plain documents (rich text with attachments, iWork files): opened, not run.
    public static let documentPackageTypes: [String] = [
        "com.apple.rtfd", "com.apple.iwork.pages.sffpages", "com.apple.iwork.keynote.sffkey",
        "com.apple.iwork.numbers.sffnumbers", "com.apple.iwork.pages.pages", "com.apple.iwork.keynote.key",
        "com.apple.iwork.numbers.numbers",
    ]

    /// What the opener needs to know about the item a file URL leads to (after `canonical`).
    public struct DocumentFacts: Sendable, Equatable {
        public var path: String
        public var exists: Bool
        public var isDirectory: Bool
        public var isPackage: Bool
        public var isExecutable: Bool
        public var isAlias: Bool
        /// Holds `Contents/Info.plist` or `Info.plist`: shaped like a bundle, whatever its name.
        public var bundleShaped: Bool
        /// The item's content type and whether it conforms to one of `executableTypes` /
        /// `documentPackageTypes` (the caller asks `UTType`).
        public var contentType: String?
        public var executableType: Bool
        public var documentPackage: Bool

        public init(path: String, exists: Bool = true, isDirectory: Bool = false, isPackage: Bool = false, isExecutable: Bool = false,
                    isAlias: Bool = false, bundleShaped: Bool = false, contentType: String? = nil, executableType: Bool = false,
                    documentPackage: Bool = false) {
            self.path = path
            self.exists = exists
            self.isDirectory = isDirectory
            self.isPackage = isPackage
            self.isExecutable = isExecutable
            self.isAlias = isAlias
            self.bundleShaped = bundleShaped
            self.contentType = contentType
            self.executableType = executableType
            self.documentPackage = documentPackage
        }
    }

    /// Refuses a document that would run instead of open: an app, bundle or package, an
    /// executable file (with or without an extension), a script, an alias or location file, or
    /// anything whose name or content type says so. `requested` is the path as the URL spelled it.
    public static func checkDocument(_ facts: DocumentFacts, requested: String) throws {
        let refuse = { (why: String) in
            CapabilityError(.policyDenied, reason: "executable_document", "Psyche does not open scripts or apps as documents (\(why))",
                            details: ["path": .string(facts.path)])
        }
        guard facts.exists else {
            throw CapabilityError(.notFound, reason: "document_not_found", "\(facts.path) does not exist")
        }
        for name in [facts.path, requested] {
            let ext = (name as NSString).pathExtension.lowercased()
            if executableExtensions.contains(ext) { throw refuse(".\(ext)") }
            if (name as NSString).lastPathComponent.unicodeScalars.contains(where: { $0.properties.generalCategory == .format }) {
                throw refuse("hidden characters in the name")
            }
        }
        if facts.isAlias { throw refuse("an alias") }
        if facts.executableType { throw refuse(facts.contentType ?? "an executable type") }
        if facts.isDirectory {
            if facts.bundleShaped { throw refuse("a bundle") }
            if facts.isPackage, !facts.documentPackage { throw refuse("a package") }
        } else if facts.isExecutable {
            throw refuse("an executable file")
        }
    }
}

extension FixedCaps {
    /// Content types a shell or terminal claims to open.
    static let shellTypes: Set = [
        "public.shell-script", "public.unix-executable", "com.apple.terminal.shell-script", "public.bash-script",
        "public.zsh-script", "public.csh-script", "public.ksh-script", "public.tcsh-script", "com.apple.terminal.session",
    ]

    /// Whether an app's Info.plist says it is a terminal, a shell or a developer tool: a
    /// developer-tools category, a document type it opens with the Shell role, or a claim on
    /// shell-script or unix-executable files. Such an app is capped at click like the listed
    /// terminals and IDEs, so a new terminal (Terax) is not driven at the interact tier.
    public static func isShellLike(info: [String: Any]) -> Bool {
        if let category = info["LSApplicationCategoryType"] as? String, category.lowercased() == "public.app-category.developer-tools" {
            return true
        }
        for type in info["CFBundleDocumentTypes"] as? [[String: Any]] ?? [] {
            if (type["CFBundleTypeRole"] as? String)?.lowercased() == "shell" { return true }
            let types = (type["LSItemContentTypes"] as? [String] ?? []).map { $0.lowercased() }
            if types.contains(where: shellTypes.contains) { return true }
            let exts = (type["CFBundleTypeExtensions"] as? [String] ?? []).map { $0.lowercased() }
            if exts.contains(where: { ["command", "sh", "zsh", "bash", "tool", "term"].contains($0) }) { return true }
        }
        return false
    }
}
