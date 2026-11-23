import Foundation
import PsycheStore

/// Words a Gateway notice in the phone's language. The Gateway sends message ids next to its English text; an id
/// this build has a String Catalog entry for is shown in the owner's language, and anything else (an unknown id
/// from a newer Gateway, a notice without ids) shows the Gateway's English text.
enum NoticeWording {
    /// The keys this build words itself. Each one has an entry in `Localizable.xcstrings` in every language.
    static let knownKeys: Set<String> = [
        "notice.codeRun.held.title", "notice.codeRun.held.body",
        "notice.codeRun.changed.title", "notice.codeRun.changed.body",
        "notice.codeRun.partial.title", "notice.codeRun.partial.body",
        "notice.codeRun.recreated.title", "notice.codeRun.recreated.body",
        "notice.codeRun.incident.title", "notice.codeRun.incident.body",
        "notice.codeRun.unmoved.title", "notice.codeRun.unmoved.body",
        "notice.machine.added.title", "notice.machine.added.body",
        "notice.machine.removed.title", "notice.machine.removed.body",
        "notice.machine.offline.title", "notice.machine.offline.body",
        "notice.machine.scanIncomplete.title", "notice.machine.scanIncomplete.body",
        "notice.codeRun.unchecked.title", "notice.codeRun.unchecked.body",
        "notice.approvals.digest.body", "notice.attention.paused.title", "notice.attention.paused.body",
        "notice.browser.chrome.title", "notice.browser.chrome.body",
        "notice.browser.takeover.title", "notice.browser.takeover.body",
        "notice.connector.changed.title", "notice.connector.consent.title", "notice.connector.consent.body",
        "notice.connector.reconnect.title", "notice.connector.reconnect.body",
        "notice.mcp.changed.title", "notice.mcp.review.body", "notice.mcp.suspicious.title",
        "notice.security.changed.title", "notice.security.firstAdmin.title", "notice.security.firstSeal.title",
        "notice.security.tightened.body", "notice.security.untrusted.title", "notice.security.untrusted.body",
        "notice.action.keepIt",
    ]

    static func title(_ item: InboxItem) -> String {
        text(item.message?.titleKey, item.message?.params ?? [:], fallback: item.title)
    }

    static func body(_ item: InboxItem) -> String {
        text(item.message?.bodyKey, item.message?.params ?? [:], fallback: item.body)
    }

    static func label(_ action: InboxAction) -> String {
        lookup(action.labelKey) ?? action.label
    }

    /// The catalog text for `key` with `{name}` placeholders filled from `params`, or `fallback` when the key is
    /// unknown. A placeholder with no value stays as written.
    static func text(_ key: String?, _ params: [String: String], fallback: String) -> String {
        guard let template = lookup(key) else { return fallback }
        return fill(template, params)
    }

    /// The catalog string for a key this build knows, or nil. `Bundle.module.localizedString` returns the value
    /// passed here when the key is missing, so an empty value means "not in the catalog".
    static func lookup(_ key: String?) -> String? {
        guard let key, knownKeys.contains(key) else { return nil }
        let value = Bundle.module.localizedString(forKey: key, value: "", table: nil)
        return value.isEmpty ? nil : value
    }

    /// Fills `{name}` in one pass, so a value that itself contains braces is shown as written.
    static func fill(_ template: String, _ params: [String: String]) -> String {
        var out = ""
        var rest = template[...]
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            out += rest[..<open]
            let name = String(rest[rest.index(after: open)..<close])
            out += params[name] ?? String(rest[open...close])
            rest = rest[rest.index(after: close)...]
        }
        out += rest
        return out
    }
}
