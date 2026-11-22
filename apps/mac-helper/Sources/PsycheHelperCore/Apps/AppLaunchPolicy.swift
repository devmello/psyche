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
            + systemCryptexFolders
    }

    /// Where the system's cryptex apps really live (Safari: `/Applications/Safari.app` is a link
    /// to `/System/Cryptexes/App/System/Applications/Safari.app`, which leads to the Preboot
    /// volume). Both are sealed system locations: tier 0, like `/System/Applications`.
    public static let systemCryptexFolders = [
        "/System/Cryptexes/App/System/Applications", "/System/Volumes/Preboot/Cryptexes/App/System/Applications",
    ]

    /// Why a bundle is resolved: `open` for `apps.open` and for the target of an agent's own
    /// AppleScript or JXA; `scriptTarget` for the helper's own background launches and Apple
    /// Events (`ensureRunning` from the app backends, Messages, the Automation request), which
    /// may also be one of `coreServicesScriptIds` in `coreServicesFolder`.
    public enum Purpose: Sendable { case open, scriptTarget }

    /// Apple's background agents on the sealed system volume (Shortcuts Events lives only here).
    public static let coreServicesFolder = "/System/Library/CoreServices"

    /// The CoreServices agents the helper's own backends script (#1427 review r4): only these
    /// may come from `coreServicesFolder`, never another agent there (Image Events, VoiceOver…).
    public static let coreServicesScriptIds: Set<String> = ["com.apple.shortcuts.events"]

    /// `path` is `<folder>/<name>.app`, directly inside it.
    static func isDirectChild(_ path: String, of folder: String) -> Bool {
        guard path.hasPrefix(folder + "/") else { return false }
        let rest = path.dropFirst(folder.count + 1)
        return !rest.contains("/") && rest.lowercased().hasSuffix(".app") && rest.count > 4
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
        /// The bundle's real path (`canonical`: links followed). Judged by where it really is, so
        /// a link in `/Applications` to anywhere else is refused.
        public var realPath: @Sendable (URL) -> String

        public init(candidates: @escaping @Sendable (String) -> [URL], info: @escaping @Sendable (URL) -> [String: Any]?,
                    exists: @escaping @Sendable (URL) -> Bool, appleSigned: @escaping @Sendable (URL) -> Bool,
                    realPath: @escaping @Sendable (URL) -> String = { AppLaunchPolicy.canonical($0) }) {
            self.candidates = candidates
            self.info = info
            self.exists = exists
            self.appleSigned = appleSigned
            self.realPath = realPath
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

    /// Which launch folder a checked bundle is in: `/System` (0) before `/Applications` (1)
    /// before `~/Applications` (2).
    public static func tier(_ path: String, home: String) -> Int {
        if path.hasPrefix("/System/") { return 0 }
        if path.hasPrefix("/Applications/") { return 1 }
        return 2
    }

    /// The bundle `bundleId` opens: of the copies LaunchServices knows, only those that pass
    /// `check` count (a copy in an updater cache, DerivedData or Downloads is never launched by
    /// path, so it does not compete), and the one in the most trusted launch folder wins
    /// (`/System` > `/Applications` > `~/Applications`). Refuses an id no checked bundle has (with
    /// the reason the best other copy failed, else `app_not_found`) and two checked copies in the
    /// same launch folder tier (`app_ambiguous`: LaunchServices would pick by version).
    public static func resolve(bundleId: String, home: String, lookups: Lookups, purpose: Purpose = .open) throws -> URL {
        var seen: [String] = []
        for url in lookups.candidates(bundleId) where lookups.exists(url) {
            let path = lookups.realPath(url)
            if !seen.contains(path) { seen.append(path) }
        }
        var passed: [String] = []
        var failure: (tier: Int, error: CapabilityError)?
        for path in seen {
            do {
                try check(URL(fileURLWithPath: path), requestedId: bundleId, home: home, lookups: lookups, purpose: purpose)
                passed.append(path)
            } catch let e as CapabilityError {
                // Report why the copy nearest a launch folder failed (a lookalike Apple app).
                let rank = appFolders(home: home).contains(where: { path.hasPrefix($0 + "/") }) ? tier(path, home: home) : 3
                if failure == nil || rank < failure!.tier { failure = (rank, e) }
            }
        }
        guard let best = passed.map({ tier($0, home: home) }).min() else {
            if let failure { throw failure.error }
            throw CapabilityError(.notFound, reason: "app_not_found", "No installed app matches \(bundleId)")
        }
        let tied = passed.filter { tier($0, home: home) == best }
        if tied.count > 1 {
            throw CapabilityError(
                .policyDenied, reason: "app_ambiguous",
                "More than one copy of \(bundleId) is installed in the same Applications folder, so Psyche does not pick one. Remove the copy you do not use.",
                details: ["app": .string(bundleId), "paths": .array(tied.prefix(8).map { .string($0) })]
            )
        }
        return URL(fileURLWithPath: tied[0])
    }

    /// Before launching or scripting a checked bundle: LaunchServices activates (and Apple Events
    /// reach) an instance that is already running, so every running instance of the id must be
    /// the checked bundle. `running` holds their bundle paths (nil: unknown, refused).
    public static func checkRunning(bundleId: String, expected: URL, running: [URL?]) throws {
        let want = canonical(expected)
        for url in running where url.map(canonical) != want {
            throw CapabilityError(
                .policyDenied, reason: "app_running_elsewhere",
                "\(bundleId) is already running from \(url.map(canonical) ?? "an unknown place"), not \(want). Quit that copy and try again.",
                details: ["app": .string(bundleId), "path": .string(url.map(canonical) ?? ""), "expected": .string(want)]
            )
        }
    }

    /// After a launch: the app that came up must be the checked bundle.
    public static func checkLaunched(bundleId: String, expected: URL, launched: URL?) throws {
        let want = canonical(expected)
        guard launched.map(canonical) == want else {
            throw CapabilityError(
                .policyDenied, reason: "app_launched_elsewhere",
                "\(bundleId) came up from \(launched.map(canonical) ?? "an unknown place"), not \(want)",
                details: ["app": .string(bundleId), "path": .string(launched.map(canonical) ?? ""), "expected": .string(want)]
            )
        }
    }

    /// The rules every bundle passes before it is launched, however it was found:
    /// - it sits directly in an Applications folder (`/Applications/X.app`, `…/Utilities/X.app`),
    ///   never inside another app's bundle;
    /// - its own Info.plist names the requested id, and its executable inside the bundle
    ///   (`CFBundleExecutable` is a plain name, never `../../bin/bash`);
    /// - a `com.apple.*` id lives in `/System` or `/Applications` and carries Apple's signature.
    public static func check(_ url: URL, requestedId: String?, home: String, lookups: Lookups, purpose: Purpose = .open) throws {
        let path = lookups.realPath(url)
        let id = (lookups.info(url)?["CFBundleIdentifier"] as? String) ?? requestedId
        // A background script target may also be one of Apple's own agents in CoreServices
        // (Shortcuts Events), judged by its real path, so a link cannot lead there; the Apple
        // signature check below still applies. `apps.open` never launches from there.
        let coreService = purpose == .scriptTarget && id.map { coreServicesScriptIds.contains($0.lowercased()) } == true
            && isDirectChild(path, of: coreServicesFolder)
        guard coreService || appFolders(home: home).contains(where: { path.hasPrefix($0 + "/") }) else {
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
