import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Standing permissions: `grants.list` (operator.read) with `includeRevoked`, and `grants.revoke` (operator.admin).
// Mapping follows the desktop's `grantSubject` (PermissionsSection): the subject says exactly what a grant covers,
// and a send grant never reads as "any recipient". Whether this phone is an admin is what the Gateway granted at
// connect (`operator.admin` in the paired scopes); the Gateway still decides, and its refusal is shown as is.
extension GatewayBackend {
    public func standingGrants() async throws -> [StandingGrant] {
        Self.standingGrants(try await call("grants.list", .obj(["includeRevoked": .bool(true)])))
    }

    public func revokeGrant(id: String) async throws {
        _ = try await call("grants.revoke", .obj(["grantId": .string(id)]))
    }

    public func canRevokeGrants() async -> Bool {
        Self.isAdmin(scopes: await client.ownIdentity.scopes)
    }

    // MARK: - Mapping

    static func isAdmin(scopes: [String]) -> Bool { scopes.contains("operator.admin") }

    static func standingGrants(_ result: JSONValue) -> [StandingGrant] {
        (result["grants"]?.array ?? []).compactMap { grant in
            guard let id = grant["id"]?.string, !id.isEmpty else { return nil }
            let kind = grant["kind"]?.string ?? ""
            let key = grant["grantKey"]?.string ?? ""
            return StandingGrant(
                id: id, kind: kind, scope: grant["scope"]?.string ?? "",
                subject: subject(kind: kind, key: key, subject: grant["subject"]),
                useCount: grant["useCount"]?.int ?? 0,
                lastUsedAt: WireFormat.date(grant["lastUsedAt"]?.string),
                expiresAt: WireFormat.date(grant["expiresAt"]?.string),
                revokedAt: WireFormat.date(grant["revokedAt"]?.string))
        }
    }

    /// One line naming what a grant covers; every string the model or a site could have written is made display-safe.
    static func subject(kind: String, key: String, subject: JSONValue?) -> GrantSubject {
        func text(_ name: String) -> String? {
            guard let value = subject?[name]?.string, !value.isEmpty else { return nil }
            return DisplaySafe.text(value)
        }
        func host(_ origin: String) -> String {
            origin.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
        }
        let safeKey = DisplaySafe.text(key)

        if kind == "new_origin", let trusted = subject?["trustedSite"], let origin = trusted["origin"]?.string {
            return .trustedSite(host: DisplaySafe.text(host(origin)), subdomains: trusted["subdomains"]?.bool == true)
        }
        if kind == "new_origin" { return .origin(host: host(text("origin") ?? safeKey)) }
        if kind == "connector_action", subject?["titlePrefix"]?.string == "Prep:" { return .prepNotes }
        if kind == "connector_action" || kind == "mcp_tool" { return .named(text("action") ?? text("tool") ?? safeKey) }
        if kind == "exec_host", let program = subject?["hostProgram"], let executable = program["executable"]?.string {
            let folder = DisplaySafe.text(program["folder"]?.string ?? "")
            if let argv = program["argv"]?.array {
                let line = argv.compactMap(\.string).joined(separator: " ")
                return .hostProgram(program: DisplaySafe.text(line), folder: folder, exactArguments: true)
            }
            let name = executable.split(separator: "/").last.map(String.init) ?? executable
            return .hostProgram(program: DisplaySafe.text(name), folder: folder, exactArguments: false)
        }
        if kind == "exec", let argv = subject?["argv"]?.array {
            return .command(DisplaySafe.text(argv.compactMap(\.string).joined(separator: " ")), folder: text("cwd"))
        }
        if kind == "send_email" {
            let parsed = sendKey(key)
            var recipients: String?
            if subject?["target"]?["kind"]?.string == "recipient", let value = subject?["target"]?["value"]?.string {
                recipients = splitRecipients(value).joined(separator: ", ")
            }
            if recipients?.isEmpty != false { recipients = parsed?.recipients.joined(separator: ", ") }
            guard let recipients, !recipients.isEmpty else { return .other(safeKey) }
            let account = text("account") ?? parsed.map { DisplaySafe.text($0.account) }
            return .email(recipients: DisplaySafe.text(recipients), account: account)
        }
        if kind == "calendar_write" {
            let id = text("calendarId")?.trimmingCharacters(in: .whitespaces)
            return .calendar(id: id?.isEmpty == false ? id : nil)
        }
        return .other(safeKey)
    }

    static func splitRecipients(_ value: String) -> [String] {
        value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// `send_email:<account>:<recipients>`, possibly namespaced by the tool (`<tool>|send_email:...`). An account
    /// may contain `:`, a canonical address never does, so the account ends at the last `:`.
    static func sendKey(_ key: String) -> (account: String, recipients: [String])? {
        let prefix = "send_email:"
        let bare: Substring
        if key.hasPrefix(prefix) {
            bare = key.dropFirst(prefix.count)
        } else if let bar = key.firstIndex(of: "|"), key[key.index(after: bar)...].hasPrefix(prefix) {
            bare = key[key.index(after: bar)...].dropFirst(prefix.count)
        } else {
            return nil
        }
        guard let cut = bare.lastIndex(of: ":"), cut != bare.startIndex else { return nil }
        let recipients = splitRecipients(String(bare[bare.index(after: cut)...]))
        guard !recipients.isEmpty else { return nil }
        return (String(bare[..<cut]), recipients)
    }
}
