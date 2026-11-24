import Foundation

/// Standing permissions fixture state: several grants, one expired and one revoked. This fixture phone is
/// an admin phone, so the screens show Revoke; `FixtureBackend.setGrantsAdmin(false)` turns that off (tests).
struct GrantsState: Sendable {
    var isAdmin = true
    var grants: [StandingGrant] = {
        let now = Date.now
        return [
            StandingGrant(
                id: "grt_site", kind: "new_origin", scope: "always",
                subject: .trustedSite(host: "docs.example.com", subdomains: true), useCount: 14,
                lastUsedAt: now.addingTimeInterval(-3_600)),
            StandingGrant(
                id: "grt_mail", kind: "send_email", scope: "always",
                subject: .email(recipients: "sam@example.com", account: "Mail"), useCount: 3,
                lastUsedAt: now.addingTimeInterval(-86_400 * 2)),
            StandingGrant(
                id: "grt_prep", kind: "connector_action", scope: "always", subject: .prepNotes, useCount: 6,
                lastUsedAt: now.addingTimeInterval(-86_400)),
            StandingGrant(
                id: "grt_git", kind: "exec_host", scope: "session",
                subject: .hostProgram(program: "git", folder: "~/Projects/psyche", exactArguments: false),
                useCount: 41, lastUsedAt: now.addingTimeInterval(-600), expiresAt: now.addingTimeInterval(7_200)),
            StandingGrant(
                id: "grt_old", kind: "mcp_tool", scope: "task", subject: .named("linear.create_issue"), useCount: 1,
                lastUsedAt: now.addingTimeInterval(-86_400 * 9), expiresAt: now.addingTimeInterval(-86_400 * 8)),
            StandingGrant(
                id: "grt_gone", kind: "calendar_write", scope: "always", subject: .calendar(id: nil), useCount: 2,
                lastUsedAt: now.addingTimeInterval(-86_400 * 20), revokedAt: now.addingTimeInterval(-86_400 * 3)),
        ]
    }()
}

extension FixtureBackend: GrantsBackend {
    public func standingGrants() async throws -> [StandingGrant] {
        await pause()
        return grantsState.grants
    }

    public func revokeGrant(id: String) async throws {
        await pause()
        guard grantsState.isAdmin else { throw BackendError.refused("This phone needs admin access to revoke.") }
        guard let index = grantsState.grants.firstIndex(where: { $0.id == id }) else { throw BackendError.notFound }
        if grantsState.grants[index].revokedAt == nil { grantsState.grants[index].revokedAt = .now }
    }

    public func canRevokeGrants() async -> Bool { grantsState.isAdmin }

    /// Tests: turn this fixture phone's admin scope on or off.
    public func setGrantsAdmin(_ isAdmin: Bool) { grantsState.isAdmin = isAdmin }
}
