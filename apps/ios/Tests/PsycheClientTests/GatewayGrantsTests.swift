import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Standing permissions over a scripted Gateway: how `grants.list` rows read, that revoked rows come back
/// (`includeRevoked`), what `grants.revoke` sends, the admin gate (the scopes granted at connect), and the
/// Gateway's own refusals shown as they are.
struct GatewayGrantsTests {
    static func grant(
        _ id: String, kind: String, scope: String = "always", key: String = "k", subject: JSONValue = .object([:]),
        expiresAt: JSONValue = .null, revokedAt: JSONValue = .null, useCount: Int = 0, lastUsedAt: JSONValue = .null
    ) -> JSONValue {
        .object([
            "id": .string(id), "kind": .string(kind), "scope": .string(scope), "grantKey": .string(key),
            "subject": subject, "binding": .null, "expiresAt": expiresAt, "useCount": .number(Double(useCount)),
            "lastUsedAt": lastUsedAt, "createdFromApprovalId": .null, "taskId": .null,
            "createdAt": "2030-01-01T09:00:00Z", "revokedAt": revokedAt,
        ])
    }

    static let list: JSONValue = .object(["grants": .array([
        grant("g1", kind: "new_origin", subject: .object(["trustedSite": .object(["origin": "https://docs.example.com", "subdomains": .bool(true)])]),
              useCount: 14, lastUsedAt: "2030-01-02T09:00:00Z"),
        grant("g2", kind: "new_origin", key: "https://news.example.org", subject: .object(["origin": "https://news.example.org"])),
        grant("g3", kind: "send_email", key: "mail|send_email:apple-mail:c1:b@x.com,a@x.com",
              subject: .object(["target": .object(["kind": "recipient", "value": "a@x.com, b@x.com"]), "account": "apple-mail:c1"])),
        grant("g4", kind: "send_email", key: "send_email:acct:z@x.com"),
        grant("g5", kind: "connector_action", subject: .object(["action": "calendar.create", "titlePrefix": "Prep:"])),
        grant("g6", kind: "mcp_tool", subject: .object(["tool": "linear.create_issue"]),
              expiresAt: "2030-01-01T10:00:00Z"),
        grant("g7", kind: "exec_host", scope: "session", subject: .object(["hostProgram": .object(
            ["executable": "/usr/bin/git", "folder": "/Users/me/proj"])])),
        grant("g8", kind: "exec_host", subject: .object(["hostProgram": .object(
            ["executable": "/usr/bin/git", "folder": "/p", "argv": .array(["git", "status"])])])),
        grant("g9", kind: "exec", subject: .object(["argv": .array(["ls", "-la"]), "cwd": "/tmp"])),
        grant("g10", kind: "calendar_write", subject: .object(["calendarId": "  work "]), revokedAt: "2030-01-03T00:00:00Z"),
        grant("g11", kind: "calendar_write", subject: .object(["calendarId": "  "])),
        grant("g12", kind: "something_new", key: "weird|key"),
        .object(["id": "", "kind": "exec"]),
    ])])

    @Test func theListMapsEveryGrantTheWayTheDesktopWordsIt() async throws {
        let (backend, gateway) = try await live { g in g.on("grants.list") { _ in .success(Self.list) } }
        let grants = try await backend.standingGrants()
        #expect(grants.map(\.id) == ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10", "g11", "g12"])
        #expect(grants[0].subject == .trustedSite(host: "docs.example.com", subdomains: true))
        #expect(grants[0].useCount == 14)
        #expect(grants[0].lastUsedAt != nil)
        #expect(grants[1].subject == .origin(host: "news.example.org"))
        #expect(grants[2].subject == .email(recipients: "a@x.com, b@x.com", account: "apple-mail:c1"))
        // A send grant with no target reads its recipients and account from the key, never "any recipient".
        #expect(grants[3].subject == .email(recipients: "z@x.com", account: "acct"))
        #expect(grants[4].subject == .prepNotes)
        #expect(grants[5].subject == .named("linear.create_issue"))
        #expect(grants[6].subject == .hostProgram(program: "git", folder: "/Users/me/proj", exactArguments: false))
        #expect(grants[7].subject == .hostProgram(program: "git status", folder: "/p", exactArguments: true))
        #expect(grants[8].subject == .command("ls -la", folder: "/tmp"))
        #expect(grants[9].subject == .calendar(id: "work"))
        #expect(grants[10].subject == .calendar(id: nil))
        #expect(grants[11].subject == .other("weird|key"))
        #expect(gateway.received.first { $0.method == "grants.list" }?.params == .object(["includeRevoked": .bool(true)]))
    }

    @Test func statusComesFromRevokedAtAndExpiry() async throws {
        let (backend, _) = try await live { g in g.on("grants.list") { _ in .success(Self.list) } }
        let grants = try await backend.standingGrants()
        let now = try #require(WireFormat.date("2030-06-01T00:00:00Z"))
        #expect(grants[0].status(now: now) == .active)
        #expect(grants[5].status(now: now) == .expired)
        #expect(grants[5].status(now: try #require(WireFormat.date("2030-01-01T09:00:00Z"))) == .active)
        #expect(grants[9].status(now: now) == .revoked)
    }

    @Test func hiddenFormatCharactersInASubjectShowAsMarkers() async throws {
        let (backend, _) = try await live { g in
            g.on("grants.list") { _ in .success(.object(["grants": .array([
                Self.grant("g1", kind: "mcp_tool", subject: .object(["tool": "safe\u{202E}tool"])),
            ])])) }
        }
        let grant = try #require(try await backend.standingGrants().first)
        #expect(grant.subject == .named("safe⟨U+202E⟩tool"))
    }

    @Test func revokeSendsOnlyTheGrantId() async throws {
        let (backend, gateway) = try await live { g in
            g.pairedScopes = ["operator.read", "operator.admin"]
            g.on("grants.revoke") { _ in .success(.object(["grant": Self.grant("g1", kind: "exec")])) }
        }
        try await backend.revokeGrant(id: "g1")
        let sent = gateway.received.filter { $0.method == "grants.revoke" }
        #expect(sent.count == 1)
        #expect(sent.first?.params == .object(["grantId": "g1"]))
    }

    @Test func onlyAPhoneWithAdminScopeIsOfferedRevoke() async throws {
        let (admin, _) = try await live { g in g.pairedScopes = ["operator.read", "operator.admin"] }
        #expect(await admin.canRevokeGrants())
        let (reader, _) = try await live { _ in }
        #expect(await reader.canRevokeGrants() == false)
        #expect(GatewayBackend.isAdmin(scopes: ["operator.approvals", "operator.write"]) == false)
        #expect(GatewayBackend.isAdmin(scopes: []) == false)
    }

    @Test func aRefusedListOrRevokeShowsTheGatewaysMessage() async throws {
        let (backend, _) = try await live { g in
            g.on("grants.list") { _ in .failure(WireError(code: "forbidden", message: "Needs read access.")) }
            g.on("grants.revoke") { _ in .failure(WireError(code: "forbidden", message: "Needs admin access.")) }
        }
        await #expect(throws: BackendError.refused("Needs read access.")) { try await backend.standingGrants() }
        await #expect(throws: BackendError.refused("Needs admin access.")) { try await backend.revokeGrant(id: "g1") }
    }

    private func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, FakeGateway) {
        let (backend, harness) = try await GatewayBackendTests().live(configure)
        return (backend, harness.gateway)
    }
}
