import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

private let installed = [
    "notes": "com.apple.Notes", "com.apple.notes": "com.apple.Notes", "terminal": "com.apple.Terminal",
    "com.apple.terminal": "com.apple.Terminal", "iterm": "com.googlecode.iterm2", "com.googlecode.iterm2": "com.googlecode.iterm2",
    "finder": "com.apple.finder", "safari": "com.apple.Safari", "system settings": "com.apple.systempreferences",
    "microsoft word": "com.microsoft.Word",
]

private func resolve(_ s: String) -> String? { installed[s.lowercased()] ?? installed.values.first { $0.lowercased() == s.lowercased() } }

private func reason(_ source: String, _ language: ScriptGuard.Language = .appleScript, target: String? = "com.apple.Notes") -> String? {
    do {
        try ScriptGuard.check(source, language: language, target: target, resolve: resolve)
        return nil
    } catch let e as CapabilityError {
        return e.reason
    } catch {
        return "\(error)"
    }
}

@Suite("script guard (#268)")
struct ScriptGuardTests {
    @Test func issueBypassesAreRefused() {
        #expect(reason("ObjC .import('Foundation'); $ .NSTask.alloc.init", .javaScript) == "shell_escape")
        #expect(reason("""
        use framework "Foundation"
        current application's NSTask's launchedTaskWithLaunchPath:"/bin/sh" arguments:{"-c", "id"}
        """) == "shell_escape")
        #expect(reason("var a = Application('Notes'); a['doShell'+'Script']('id')", .javaScript) == "shell_escape")
        #expect(reason("var f = () => 1; Application('Notes')", .javaScript) == "shell_escape")
        #expect(reason("tell application \"Finder\" to open POSIX file \"/tmp/x.command\"", target: "com.apple.finder") == "script_target_capped")
        #expect(ScriptGuard.addressedApps("tell app id \"com.googlecode.iterm2\" to activate") == ["com.googlecode.iterm2"])
        #expect(reason("tell app id \"com.googlecode.iterm2\" to activate") == "script_target_mismatch")
        #expect(reason("tell application \"Terminal\" to activate", target: "com.apple.Terminal") == "script_target_capped")
    }

    @Test func tokensCannotBeSplitOrHidden() {
        #expect(reason("do   shell script \"id\"") == "shell_escape")
        #expect(reason("do shell ¬\nscript \"id\"") == "shell_escape")
        #expect(reason("do\u{200B}shell script \"id\"") == "shell_escape")
        #expect(reason("DO SHELL SCRIPT \"id\"") == "shell_escape")
        #expect(reason("tell application \"Notes\" to «event sysoexec» \"id\"") == "shell_escape")
        #expect(reason("run script \"do shell\" & \" script\"") == "shell_escape")
        #expect(reason("set the clipboard to \"x\"") == "shell_escape")
        #expect(reason("read POSIX file \"/etc/hosts\"") == "shell_escape")
        #expect(reason("var x = $; x.NSTask", .javaScript) == "shell_escape")
        #expect(reason("eval ('1')", .javaScript) == "shell_escape")
        #expect(reason("Application('Notes')[`doShellScript`]('id')", .javaScript) == "shell_escape")
        #expect(reason("Library('x')", .javaScript) == "shell_escape")
        #expect(reason("Application.currentApplication().doShellScript('id')", .javaScript) == "shell_escape")
    }

    @Test func everyAddressedAppMustBeTheTarget() {
        #expect(reason("tell application \"Notes\" to count notes") == nil)
        #expect(reason("tell application id \"com.apple.Notes\" to count notes") == nil)
        #expect(reason("Application('Notes').notes().length", .javaScript) == nil)
        #expect(reason("Application ( \"Notes\" ).notes.name()", .javaScript) == nil)
        #expect(reason("tell application \"Notes\"\n tell application \"Terminal\" to activate\nend tell") == "script_target_mismatch")
        #expect(reason("tell application \"/System/Applications/Utilities/Terminal.app\" to activate") == "script_target_mismatch")
        #expect(reason("Application('Notes'); Application('iTerm')", .javaScript) == "script_target_mismatch")
        #expect(reason("Application('Microsoft Word').activate()", .javaScript, target: "com.microsoft.Word") == nil)
    }

    @Test func dynamicAppReferencesAreRefused() {
        #expect(reason("set t to \"Terminal\"\ntell application t to activate") == "script_dynamic_target")
        #expect(reason("tell application (\"Ter\" & \"minal\") to activate") == "script_dynamic_target")
        #expect(reason("tell application id t to activate") == "script_dynamic_target")
        #expect(reason("tell application file id \"com.apple.Terminal\" to activate") == "script_dynamic_target")
        #expect(reason("var n = 'Terminal'; Application(n).activate()", .javaScript) == "script_dynamic_target")
        #expect(reason("var A = Application; A('Terminal').activate()", .javaScript) == "script_dynamic_target")
        #expect(reason("Application(('Terminal')).activate()", .javaScript) == "script_dynamic_target")
    }

    @Test func theTargetIsRequiredAndCapped() {
        #expect(reason("tell application \"Notes\" to count notes", target: nil) == "invalid_params")
        #expect(reason("tell application \"System Events\" to count processes", target: "System Events") == "system_events")
        #expect(reason("tell application \"Safari\" to activate", target: "com.apple.Safari") == "script_target_capped")
        #expect(reason("tell application \"System Settings\" to activate", target: "com.apple.systempreferences") == "script_target_capped")
        #expect(reason("tell application \"Nope\" to activate", target: "Nope") == "script_target_unknown")
    }
}
