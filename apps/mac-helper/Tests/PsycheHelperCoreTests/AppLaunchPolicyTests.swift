import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

/// `apps.open` launch rules (review of `apps.open`, 2026-11-19). Fakes stand in for
/// LaunchServices, Info.plist reads and the code-signing check: nothing is registered or launched.
private let home = "/Users/owner"

private struct FakeBundle: Sendable {
    var path: String
    var id: String
    var executable = "App"
    var appleSigned = false
    var exists = true
}

private func lookups(_ bundles: [FakeBundle]) -> AppLaunchPolicy.Lookups {
    let byPath = Dictionary(bundles.map { (AppLaunchPolicy.canonical(URL(fileURLWithPath: $0.path)), $0) }, uniquingKeysWith: { a, _ in a })
    let all = bundles
    let index = byPath
    return AppLaunchPolicy.Lookups(
        candidates: { id in all.filter { $0.id.lowercased() == id.lowercased() }.map { URL(fileURLWithPath: $0.path) } },
        info: { url in
            guard let b = index[AppLaunchPolicy.canonical(url)] else { return nil }
            return ["CFBundleIdentifier": b.id, "CFBundleExecutable": b.executable]
        },
        exists: { url in index[AppLaunchPolicy.canonical(url)]?.exists ?? false },
        appleSigned: { url in index[AppLaunchPolicy.canonical(url)]?.appleSigned ?? false }
    )
}

private func reason(_ id: String, _ bundles: [FakeBundle]) -> String? {
    do {
        _ = try AppLaunchPolicy.resolve(bundleId: id, home: home, lookups: lookups(bundles))
        return nil
    } catch let e as CapabilityError {
        return e.reason
    } catch {
        return "\(error)"
    }
}

private let notes = FakeBundle(path: "/System/Applications/Notes.app", id: "com.apple.Notes", appleSigned: true)

@Suite("apps.open launch policy")
struct AppLaunchPolicyTests {
    @Test func opensTheOneInstalledBundle() throws {
        #expect(reason("com.apple.Notes", [notes]) == nil)
        #expect(reason("COM.APPLE.NOTES", [notes]) == nil)
        let url = try AppLaunchPolicy.resolve(bundleId: "com.apple.Notes", home: home, lookups: lookups([notes]))
        #expect(url.path == "/System/Applications/Notes.app")
        // A third-party app in ~/Applications stays launchable (Zephium).
        #expect(reason("app.zephium", [FakeBundle(path: home + "/Applications/Zephium.app", id: "app.zephium")]) == nil)
        #expect(reason("com.example.Tool", [FakeBundle(path: "/Applications/Utilities/Tool.app", id: "com.example.Tool")]) == nil)
        #expect(reason("com.adobe.Photoshop", [FakeBundle(path: "/Applications/Adobe Photoshop/Photoshop.app", id: "com.adobe.Photoshop")]) == nil)
    }

    private func resolved(_ id: String, _ bundles: [FakeBundle]) -> String? {
        try? AppLaunchPolicy.resolve(bundleId: id, home: home, lookups: lookups(bundles)).path
    }

    /// Probe: an agent-written `Notes.app` in `~/Applications` claiming `com.apple.Notes`. It
    /// fails the checks, so it never competes: the real Notes opens.
    @Test func aLookalikeNeverWinsOverTheRealApp() {
        let fake = FakeBundle(path: home + "/Applications/Notes.app", id: "com.apple.Notes")
        #expect(resolved("com.apple.Notes", [notes, fake]) == notes.path)
        #expect(resolved("com.apple.Notes", [fake, notes]) == notes.path)
        // A signed-looking lookalike in a project folder is outside every launch folder.
        var project = FakeBundle(path: home + "/Projects/x/Notes.app", id: "com.apple.Notes")
        project.appleSigned = true
        #expect(resolved("com.apple.Notes", [project, notes]) == notes.path)
    }

    /// Review r1, finding 2: Spotify keeps an updater copy in Application Support; dev builds sit
    /// in DerivedData. Copies outside the launch folders are never launched, so they do not count.
    @Test func copiesOutsideTheLaunchFoldersDoNotCount() {
        let spotify = FakeBundle(path: "/Applications/Spotify.app", id: "com.spotify.client")
        let updater = FakeBundle(path: home + "/Library/Application Support/Spotify/PersistentCache/Update/temp/Spotify.app", id: "com.spotify.client")
        let derived = FakeBundle(path: home + "/Library/Developer/Xcode/DerivedData/X/Build/Products/Debug/Spotify.app", id: "com.spotify.client")
        let downloads = FakeBundle(path: home + "/Downloads/Spotify.app", id: "com.spotify.client")
        #expect(resolved("com.spotify.client", [updater, spotify, derived, downloads]) == spotify.path)
        // Only such copies: refused with the reason the copy failed.
        #expect(reason("com.spotify.client", [updater, downloads]) == "app_outside_applications")
    }

    @Test func picksByLaunchFolderAndRefusesOnlyATie() {
        let a = FakeBundle(path: "/Applications/Zephium.app", id: "app.zephium")
        let b = FakeBundle(path: home + "/Applications/Zephium.app", id: "app.zephium")
        // /Applications beats ~/Applications, in either order.
        #expect(resolved("app.zephium", [b, a]) == a.path)
        #expect(resolved("app.zephium", [a, b]) == a.path)
        // /System beats /Applications.
        let sys = FakeBundle(path: "/System/Applications/Tool.app", id: "com.example.Tool")
        let apps = FakeBundle(path: "/Applications/Tool.app", id: "com.example.Tool")
        #expect(resolved("com.example.Tool", [apps, sys]) == sys.path)
        // ~/Applications alone is fine.
        #expect(resolved("app.zephium", [b]) == b.path)
        // Two checked copies in one tier: refused, with both paths.
        let c = FakeBundle(path: "/Applications/Utilities/Zephium.app", id: "app.zephium")
        #expect(reason("app.zephium", [a, c]) == "app_ambiguous")
        let d = FakeBundle(path: home + "/Applications/Old/Zephium.app", id: "app.zephium")
        #expect(reason("app.zephium", [b, d]) == "app_ambiguous")
        // A tie below the winner does not matter.
        #expect(resolved("app.zephium", [a, b, d]) == a.path)
    }

    /// Review r2, finding 1: `/Applications/Safari.app` links to the Safari cryptex, a sealed
    /// system location. A link a user made in /Applications to anywhere else is still refused.
    @Test func safariThroughItsCryptexLinkIsASystemApp() throws {
        let link = "/Applications/Safari.app"
        let real = "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"
        let links = [link: real, "/Applications/Evil.app": home + "/Projects/x/Evil.app",
                     "/Applications/Tool.app": "/tmp/Tool.app"]
        let ids = [real: "com.apple.Safari", home + "/Projects/x/Evil.app": "com.x.evil", "/tmp/Tool.app": "com.example.Tool",
                   "/System/Cryptexes/App/System/Applications/Safari.app": "com.apple.Safari",
                   home + "/Applications/Safari.app": "com.apple.Safari"]
        let l = AppLaunchPolicy.Lookups(
            candidates: { id in links.keys.filter { ids[links[$0] ?? $0] == id }.map { URL(fileURLWithPath: $0) } },
            info: { url in ids[url.path].map { ["CFBundleIdentifier": $0, "CFBundleExecutable": "App"] } },
            exists: { _ in true },
            appleSigned: { $0.path.hasPrefix("/System/") },
            realPath: { links[$0.path] ?? $0.path }
        )
        let safari = try AppLaunchPolicy.resolve(bundleId: "com.apple.Safari", home: home, lookups: l)
        #expect(safari.path == real)
        #expect(AppLaunchPolicy.tier(real, home: home) == 0)
        // The other cryptex spelling is a system folder too.
        try AppLaunchPolicy.check(URL(fileURLWithPath: "/System/Cryptexes/App/System/Applications/Safari.app"),
                                  requestedId: "com.apple.Safari", home: home, lookups: l)
        // A copy in ~/Applications loses to the system one (and fails the Apple check anyway).
        let both = AppLaunchPolicy.Lookups(
            candidates: { _ in [URL(fileURLWithPath: link), URL(fileURLWithPath: home + "/Applications/Safari.app")] },
            info: l.info, exists: l.exists, appleSigned: { _ in true }, realPath: l.realPath)
        #expect(try AppLaunchPolicy.resolve(bundleId: "com.apple.Safari", home: home, lookups: both).path == real)
        // Links a user made in /Applications are judged where they lead.
        for (id, why) in [("com.x.evil", "app_outside_applications"), ("com.example.Tool", "app_outside_applications")] {
            do {
                _ = try AppLaunchPolicy.resolve(bundleId: id, home: home, lookups: l)
                Issue.record("\(id) must be refused")
            } catch let e as CapabilityError {
                #expect(e.reason == why)
            }
        }
        // Not every /System path is a launch folder: a cryptex's other folders are not.
        #expect(throws: CapabilityError.self) {
            try AppLaunchPolicy.check(URL(fileURLWithPath: "/System/Volumes/Preboot/Cryptexes/App/usr/X.app"),
                                      requestedId: nil, home: home, lookups: l)
        }
    }

    /// Review r3: Shortcuts Events lives only in CoreServices. A background script target may be
    /// Apple's own agent there; `apps.open` never launches from there, and nothing else does.
    @Test func appleAgentsInCoreServicesAreScriptTargetsOnly() throws {
        let events = "/System/Library/CoreServices/Shortcuts Events.app"
        var agent = FakeBundle(path: events, id: "com.apple.shortcuts.events", appleSigned: true)
        let l = lookups([agent])
        let url = try AppLaunchPolicy.resolve(bundleId: "com.apple.shortcuts.events", home: home, lookups: l, purpose: .scriptTarget)
        #expect(url.path == events)
        // apps.open (the default purpose) still refuses it.
        #expect(reason("com.apple.shortcuts.events", [agent]) == "app_outside_applications")
        // Not Apple-signed: refused even as a script target.
        agent.appleSigned = false
        #expect(throws: CapabilityError.self) {
            try AppLaunchPolicy.resolve(bundleId: "com.apple.shortcuts.events", home: home, lookups: lookups([agent]), purpose: .scriptTarget)
        }
        // A non-Apple id at that path is refused as a script target.
        let other = FakeBundle(path: "/System/Library/CoreServices/Helper.app", id: "com.example.helper", appleSigned: true)
        do {
            _ = try AppLaunchPolicy.resolve(bundleId: "com.example.helper", home: home, lookups: lookups([other]), purpose: .scriptTarget)
            Issue.record("a non-Apple id in CoreServices must be refused")
        } catch let e as CapabilityError {
            #expect(e.reason == "app_outside_applications")
        }
        // Only direct children: not deeper, not a lookalike folder name.
        for path in ["/System/Library/CoreServices/Finder.app/Contents/Applications/X.app",
                     "/System/Library/CoreServicesX/X.app", "/System/Library/CoreServices/X"] {
            let b = FakeBundle(path: path, id: "com.apple.x", appleSigned: true)
            #expect(throws: CapabilityError.self) {
                try AppLaunchPolicy.resolve(bundleId: "com.apple.x", home: home, lookups: lookups([b]), purpose: .scriptTarget)
            }
        }
        // Judged by the real path: a copy named like it in a granted folder does not count.
        let linked = AppLaunchPolicy.Lookups(
            candidates: { _ in [URL(fileURLWithPath: home + "/Projects/Shortcuts Events.app")] },
            info: { _ in ["CFBundleIdentifier": "com.apple.shortcuts.events", "CFBundleExecutable": "X"] },
            exists: { _ in true }, appleSigned: { _ in true },
            realPath: { $0.path })
        #expect(throws: CapabilityError.self) {
            try AppLaunchPolicy.resolve(bundleId: "com.apple.shortcuts.events", home: home, lookups: linked, purpose: .scriptTarget)
        }
    }

    /// Review r1, finding 2: LaunchServices activates an instance that is already running.
    @Test func aRunningCopyMustBeTheCheckedOne() throws {
        let checked = URL(fileURLWithPath: "/Applications/Zephium.app")
        try AppLaunchPolicy.checkRunning(bundleId: "app.zephium", expected: checked, running: [])
        try AppLaunchPolicy.checkRunning(bundleId: "app.zephium", expected: checked,
                                         running: [URL(fileURLWithPath: "/System/Volumes/Data/Applications/Zephium.app")])
        for other: URL? in [URL(fileURLWithPath: home + "/Downloads/Zephium.app"), nil] {
            #expect(throws: CapabilityError.self) {
                try AppLaunchPolicy.checkRunning(bundleId: "app.zephium", expected: checked, running: [checked, other])
            }
        }
        do {
            try AppLaunchPolicy.checkRunning(bundleId: "app.zephium", expected: checked, running: [URL(fileURLWithPath: "/tmp/Z.app")])
        } catch let e as CapabilityError {
            #expect(e.reason == "app_running_elsewhere")
        }
        // After a launch, what came up must be the checked bundle.
        try AppLaunchPolicy.checkLaunched(bundleId: "app.zephium", expected: checked, launched: checked)
        do {
            try AppLaunchPolicy.checkLaunched(bundleId: "app.zephium", expected: checked, launched: URL(fileURLWithPath: "/tmp/Z.app"))
            Issue.record("a launch from elsewhere must be refused")
        } catch let e as CapabilityError {
            #expect(e.reason == "app_launched_elsewhere")
        }
        #expect(throws: CapabilityError.self) {
            try AppLaunchPolicy.checkLaunched(bundleId: "app.zephium", expected: checked, launched: nil)
        }
    }

    /// Review r1, finding 9: a script target capped by its Info.plist is refused.
    @Test func scriptTargetsUseTheInfoPlistCap() {
        let resolve: (String) -> String? = { $0 }
        #expect(throws: CapabilityError.self) {
            try ScriptGuard.checkTarget("app.example.term", resolve: resolve, cap: { $0 == "app.example.term" ? .click : .interact })
        }
        #expect((try? ScriptGuard.checkTarget("com.apple.Notes", resolve: resolve, cap: { _ in .interact })) == "com.apple.Notes")
        #expect(throws: CapabilityError.self) {
            try ScriptGuard.check("tell application id \"app.example.term\" to activate", language: .appleScript, target: "app.example.term",
                                  resolve: resolve, cap: { _ in .click })
        }
    }

    @Test func oneBundleInTwoSpellingsIsOneBundle() {
        let data = FakeBundle(path: "/System/Volumes/Data/Applications/Zephium.app", id: "app.zephium")
        let plain = FakeBundle(path: "/Applications/Zephium.app", id: "app.zephium")
        #expect(reason("app.zephium", [data, plain]) == nil)
        // A copy LaunchServices still lists but that is gone from disk does not count.
        var gone = FakeBundle(path: home + "/Applications/Zephium.app", id: "app.zephium")
        gone.exists = false
        #expect(reason("app.zephium", [plain, gone]) == nil)
        #expect(reason("app.zephium", [gone]) == "app_not_found")
        #expect(reason("app.zephium", []) == "app_not_found")
    }

    @Test func appleIdsMustBeApplesOwnCopy() {
        // Only copy, but in ~/Applications: not where Apple installs, whatever it is signed with.
        var home1 = FakeBundle(path: home + "/Applications/Notes.app", id: "com.apple.Notes")
        home1.appleSigned = true
        #expect(reason("com.apple.Notes", [home1]) == "apple_id_unsigned")
        // In /Applications, but without Apple's signature.
        #expect(reason("com.apple.Notes", [FakeBundle(path: "/Applications/Notes.app", id: "com.apple.Notes")]) == "apple_id_unsigned")
        // Apple's App Store apps in /Applications pass.
        #expect(reason("com.apple.iWork.Pages", [FakeBundle(path: "/Applications/Pages.app", id: "com.apple.iWork.Pages", appleSigned: true)]) == nil)
        // An unsigned /System bundle with an Apple id is refused too.
        #expect(reason("com.apple.Notes", [FakeBundle(path: "/System/Applications/Notes.app", id: "com.apple.Notes")]) == "apple_id_unsigned")
    }

    @Test func refusesNestedOutsideAndMismatchedBundles() {
        #expect(reason("us.zoom.helper", [FakeBundle(path: "/Applications/zoom.us.app/Contents/Frameworks/Helper.app", id: "us.zoom.helper")]) == "app_nested")
        #expect(reason("com.x.inner", [FakeBundle(path: "/Applications/Outer.app/Inner.app", id: "com.x.inner")]) == "app_nested")
        // Probe: an agent-written bundle in a granted project folder.
        #expect(reason("com.x.evil", [FakeBundle(path: home + "/Projects/demo/Evil.app", id: "com.x.evil")]) == "app_outside_applications")
        #expect(reason("com.x.evil", [FakeBundle(path: "/Applications/../tmp/Evil.app", id: "com.x.evil")]) == "app_outside_applications")
        #expect(reason("com.x.evil", [FakeBundle(path: home + "/ApplicationsX/Evil.app", id: "com.x.evil")]) == "app_outside_applications")
        // LaunchServices lists a bundle whose Info.plist now says something else.
        let swapped = AppLaunchPolicy.Lookups(
            candidates: { _ in [URL(fileURLWithPath: "/Applications/Tool.app")] },
            info: { _ in ["CFBundleIdentifier": "com.other.Tool"] }, exists: { _ in true }, appleSigned: { _ in false })
        #expect(throws: CapabilityError.self) { try AppLaunchPolicy.resolve(bundleId: "com.example.Tool", home: home, lookups: swapped) }
    }

    /// Probe: `CFBundleExecutable = "../../../../bin/bash"` resolves outside the bundle.
    @Test func refusesAnExecutableOutsideTheBundle() {
        var b = FakeBundle(path: "/Applications/Tool.app", id: "com.example.Tool")
        b.executable = "../../../../../../../../../../bin/bash"
        #expect(reason("com.example.Tool", [b]) == "app_executable_outside")
        b.executable = "/bin/bash"
        #expect(reason("com.example.Tool", [b]) == "app_executable_outside")
        b.executable = "Tool"
        #expect(reason("com.example.Tool", [b]) == nil)
    }

    @Test func nestedDetection() {
        #expect(AppLaunchPolicy.nestedInBundle("/Applications/X.app/Contents/MacOS/Y.app"))
        #expect(AppLaunchPolicy.nestedInBundle("/Applications/Y.framework/Z.app"))
        #expect(!AppLaunchPolicy.nestedInBundle("/Applications/X.app"))
        #expect(!AppLaunchPolicy.nestedInBundle("/Applications/Folder.d/X.app"))
    }

    // MARK: Documents

    private func doc(_ facts: AppLaunchPolicy.DocumentFacts, requested: String? = nil) -> String? {
        do {
            try AppLaunchPolicy.checkDocument(facts, requested: requested ?? facts.path)
            return nil
        } catch let e as CapabilityError {
            return e.reason
        } catch {
            return "\(error)"
        }
    }

    @Test func refusesDocumentsThatRun() {
        let refused: [AppLaunchPolicy.DocumentFacts] = [
            .init(path: "/tmp/a/X.app", isDirectory: true, isPackage: true, bundleShaped: true),
            // A bundle-shaped folder with an unknown name (Contents/Info.plist inside).
            .init(path: "/tmp/a/Notes.notes", isDirectory: true, bundleShaped: true),
            .init(path: "/tmp/a/flow.workflow", isDirectory: true, isPackage: true),
            .init(path: "/tmp/a/thing.pkgish", isDirectory: true, isPackage: true, contentType: "com.example.package"),
            .init(path: "/tmp/a/run", isExecutable: true),
            .init(path: "/tmp/a/notes.txt", isExecutable: true, contentType: "public.plain-text"),
            .init(path: "/tmp/a/link", isAlias: true),
            .init(path: "/tmp/a/x.data", contentType: "public.shell-script", executableType: true),
        ]
        for f in refused { #expect(doc(f) == "executable_document", "\(f.path)") }
        for ext in ["term", "webloc", "inetloc", "fileloc", "pyw", "pyc", "csh", "ksh", "fish", "prefPane", "saver", "mobileconfig",
                    "action", "workflow", "shortcut", "command", "sh", "app", "scpt", "terminal"] {
            #expect(doc(.init(path: "/tmp/a/f.\(ext)")) == "executable_document", ".\(ext)")
        }
        // The name as the URL spelled it counts too (a link named .txt to a .command is caught by
        // the target; a `.command` link to a text file by its own name).
        #expect(doc(.init(path: "/tmp/a/real.txt", contentType: "public.plain-text"), requested: "/tmp/a/run.command") == "executable_document")
        #expect(doc(.init(path: "/tmp/a/inv\u{202E}txt.command")) == "executable_document")
        #expect(doc(.init(path: "/tmp/a/gone.pdf", exists: false)) == "document_not_found")
    }

    @Test func opensPlainDocuments() {
        #expect(doc(.init(path: "/tmp/a/report.pdf", contentType: "com.adobe.pdf")) == nil)
        #expect(doc(.init(path: "/tmp/a/README", contentType: "public.data")) == nil)
        #expect(doc(.init(path: "/tmp/a/Photos", isDirectory: true)) == nil)
        #expect(doc(.init(path: "/tmp/a/notes.rtfd", isDirectory: true, isPackage: true, contentType: "com.apple.rtfd", documentPackage: true)) == nil)
        #expect(doc(.init(path: "/tmp/a/plan.pages", isDirectory: true, isPackage: true, documentPackage: true)) == nil)
    }

    // MARK: Terminals and IDEs from Info.plist

    @Test func shellLikeAppsFromTheirInfoPlist() {
        // Terax: a developer-tools app no id list names.
        #expect(FixedCaps.isShellLike(info: ["CFBundleIdentifier": "app.crynta.terax", "LSApplicationCategoryType": "public.app-category.developer-tools"]))
        #expect(FixedCaps.isShellLike(info: ["CFBundleDocumentTypes": [["CFBundleTypeRole": "Shell", "CFBundleTypeName": "Script"]]]))
        #expect(FixedCaps.isShellLike(info: ["CFBundleDocumentTypes": [["CFBundleTypeRole": "Viewer", "LSItemContentTypes": ["public.unix-executable"]]]]))
        #expect(FixedCaps.isShellLike(info: ["CFBundleDocumentTypes": [["CFBundleTypeRole": "Editor", "LSItemContentTypes": ["com.apple.terminal.shell-script"]]]]))
        #expect(FixedCaps.isShellLike(info: ["CFBundleDocumentTypes": [["CFBundleTypeExtensions": ["command"]]]]))
        // Near misses: editors and viewers of ordinary documents, other categories.
        #expect(!FixedCaps.isShellLike(info: ["LSApplicationCategoryType": "public.app-category.productivity"]))
        #expect(!FixedCaps.isShellLike(info: ["CFBundleDocumentTypes": [["CFBundleTypeRole": "Editor", "LSItemContentTypes": ["public.plain-text", "public.rtf"]]]]))
        #expect(!FixedCaps.isShellLike(info: ["CFBundleDocumentTypes": [["CFBundleTypeRole": "Viewer", "LSItemContentTypes": ["com.adobe.pdf", "public.image"]]]]))
        #expect(!FixedCaps.isShellLike(info: [:]))
    }

    @Test func listedTerminalsIncludeTheReviewedApps() {
        for id in ["app.crynta.terax", "com.github.wez.wezterm", "co.zeit.hyper", "com.vscodium", "com.exafunction.windsurf",
                   "com.google.android.studio", "com.panic.Nova", "com.barebones.bbedit", "com.apple.ScriptEditor2", "com.apple.Automator"] {
            #expect(FixedCaps.cap(for: id) == .click, "\(id)")
        }
    }

    @Test func infoPlistCapLimitsAnUnlistedTerminal() throws {
        let policy = TierPolicy(settings: TierSettings(defaultValue: .interact), infoCap: { $0 == "app.example.term" ? .click : .interact })
        #expect(policy.fixedCap(for: "app.example.term") == .click)
        #expect(policy.effectiveTier(for: "app.example.term") == .click)
        try policy.authorize(.click, bundleId: "app.example.term", appName: "Term", approval: nil)
        do {
            try policy.authorize(.type, bundleId: "app.example.term", appName: "Term", approval: nil)
            Issue.record("typing into a shell-like app must be refused")
        } catch let e as CapabilityError {
            #expect(e.reason == "tier_click")
            #expect(e.message.contains("Terminals and IDEs"))
        }
        // Other apps keep their tier; an Off app stays Off whatever its Info.plist says.
        try policy.authorize(.type, bundleId: "com.apple.Notes", appName: "Notes", approval: nil)
        #expect(policy.fixedCap(for: "com.1password.1password") == .off)
        // Without the lookup, only the lists decide.
        #expect(TierPolicy(settings: TierSettings(defaultValue: .interact)).fixedCap(for: "app.example.term") == .interact)
    }
}
