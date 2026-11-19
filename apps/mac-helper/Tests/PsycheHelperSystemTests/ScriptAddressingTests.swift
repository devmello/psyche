import Foundation
import PsycheHelperCore
import PsycheProtocol
@testable import PsycheHelperSystem
import Testing

/// Review r2, finding 4: the in-process backends address their app by bundle id, so the
/// script's own lookup never launches another copy that only shares the name.
@Suite("backend scripts address apps by id")
struct ScriptAddressingTests {
    static let sources: [(String, String, String)] = [
        ("Mail", MailScriptingBackend.source, "com.apple.mail"),
        ("Notes", NotesScriptingBackend.source, "com.apple.Notes"),
        ("Safari", SafariScriptingBackend.source, "com.apple.Safari"),
        ("Chrome", ChromeScriptingBackend.source, "com.google.Chrome"),
        ("Reminders", EventKitBackend.flagScript, "com.apple.reminders"),
        ("Things", ThingsScriptingBackend.source, "com.culturedcode.ThingsMac"),
        ("Shortcuts", LiveShortcutsBackend.source, "com.apple.shortcuts.events"),
        ("Music", MusicScriptingBackend.source("music"), "com.apple.Music"),
        ("Music library", MusicScriptingBackend.libraryScript, "com.apple.Music"),
        ("Spotify", MusicScriptingBackend.source("spotify"), "com.spotify.client"),
    ]

    @Test(arguments: sources.map(\.0))
    func addressesByBundleId(_ name: String) throws {
        let entry = try #require(Self.sources.first { $0.0 == name })
        let source = entry.1
        #expect(source.contains("tell application id \"\(entry.2)\""), "\(name)")
        // No `tell application "<name>"`: every tell names an id.
        let byName = source.components(separatedBy: "tell application \"").count - 1
        #expect(byName == 0, "\(name) addresses an app by name")
    }

    /// Review r2, finding 1: a launch check that refuses says so, with the helper's reason.
    @Test func ensureRunningSaysWhyItRefused() {
        let inner = CapabilityError(.policyDenied, reason: "app_outside_applications", "Only apps installed in an Applications folder can be opened")
        let e = ScriptHandler.ensureRunningRefusal("com.apple.Safari", inner)
        #expect(e.reason == "app_outside_applications")
        #expect(e.code == .policyDenied)
        #expect(e.message.contains("com.apple.Safari"))
        #expect(e.message.contains("Applications folder"))
        #expect(e.details["app"] == .string("com.apple.Safari"))
    }
}
