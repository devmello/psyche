import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

@Suite("capability manifest")
struct ManifestTests {
    let runtime = HelperRuntime(log: HelperLog(echo: { _ in }), environment: ["PSYCHE_HOME": NSTemporaryDirectory()])

    @Test func namesAreUniqueAndGrouped() {
        let names = runtime.registry.ordered.map(\.spec.name)
        #expect(Set(names).count == names.count)
        let groups = Set(names.map { String($0.split(separator: ".").first ?? "") })
        #expect(groups.isSuperset(of: ["computer", "apps", "permissions", "notify"]))
        for required in ["computer.ax_tree", "computer.click", "computer.double_click", "computer.right_click", "computer.type",
                         "computer.key", "computer.scroll", "computer.drag", "computer.screenshot", "computer.screenshot_pick",
                         "apps.open", "apps.focus", "apps.list", "apps.applescript", "apps.jxa", "apps.shortcut_run",
                         "permissions.status", "permissions.request", "notify.show"] {
            #expect(names.contains(required), "missing \(required)")
        }
    }

    @Test func sideEffectsAreDeclaredAndReceipted() {
        for h in runtime.registry.ordered {
            let s = h.spec
            #expect(s.inputSchema["type"] == "object", "\(s.name) schema")
            #expect(!s.description.isEmpty)
            if s.sideEffect == .write || s.sideEffect == .destructive {
                #expect(s.receiptKind != nil, "\(s.name) has no receipt kind")
            }
        }
        let byName = Dictionary(uniqueKeysWithValues: runtime.registry.ordered.map { ($0.spec.name, $0.spec) })
        #expect(byName["computer.ax_tree"]?.sideEffect == .read)
        #expect(byName["computer.click"]?.sideEffect == .write)
        #expect(byName["apps.applescript"]?.sideEffect == .destructive)
        #expect(byName["apps.shortcut_run"]?.sideEffect == .destructive)
        for (name, spec) in byName where name.hasPrefix("computer.") && name != "computer.end_session" && name != "computer.screenshot_pick" {
            #expect(spec.targetKind == .app, "\(name) targetKind")
        }
        #expect(byName["computer.click"]?.permissions == [.accessibility])
        #expect(byName["computer.screenshot"]?.permissions == [.screenRecording])
    }

    @Test func manifestEncodesAsNodeCapabilities() throws {
        let manifest = runtime.registry.manifest(version: HelperVersion.current)
        let data = try JSONEncoder().encode(manifest)
        let decoded = try JSONDecoder().decode(CapabilityManifest.self, from: data)
        #expect(decoded.platform == .macos && decoded.capabilities.count == runtime.registry.ordered.count)
        // The connect frame must stay well under the 1 MiB frame limit.
        #expect(data.count < 256 * 1024)
    }
}

@Suite("script guard and disclaimed spawn")
struct AppsTests {
    @Test func shellEscapesAreRefused() {
        #expect(throws: CapabilityError.self) { try ScriptGuard.check("do   shell script \"rm -rf ~\"", language: .appleScript) }
        #expect(throws: CapabilityError.self) { try ScriptGuard.check("app = Application.currentApplication(); app.doShellScript('id')", language: .javaScript) }
        #expect(throws: CapabilityError.self) { try ScriptGuard.check("ObjC.import('Foundation')", language: .javaScript) }
        #expect((try? ScriptGuard.check("tell application \"Notes\" to get name of every note", language: .appleScript)) != nil)
        #expect((try? ScriptGuard.check("Application('Notes').notes().length", language: .javaScript)) != nil)
    }

    @Test func disclaimedProcessRunsWithAMinimalEnvironment() async throws {
        guard DisclaimedProcess.isSupported else { return }
        let r = try await DisclaimedProcess.run("/usr/bin/env", [], timeout: 10)
        #expect(r.status == 0)
        #expect(!r.stdout.contains("PSYCHE_"))
        #expect(r.stdout.contains("PATH=/usr/bin:/bin:/usr/sbin:/sbin"))
        let fail = try await DisclaimedProcess.run("/bin/sh", ["-c", "exit 3"], timeout: 10)
        #expect(fail.status == 3)
        await #expect(throws: CapabilityError.self) { try await DisclaimedProcess.run("/bin/sleep", ["5"], timeout: 0.3) }
        await #expect(throws: CapabilityError.self) { try await DisclaimedProcess.run("sh", [], timeout: 1) }
    }
}
