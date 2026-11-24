import Foundation

// Standing permissions on the phone (Settings → Standing permissions): what the owner said "Always allow" to.
// Gateway methods: grants.list (operator.read) and grants.revoke (operator.admin). The list is read with
// `includeRevoked` so a revoked row still shows as revoked, as on the desktop. Revoking is a plain tap after a
// confirmation: no Touch ID, no delay (presence is for payments only). Only an admin phone is offered Revoke.

/// What one grant covers, structured so the phone words it in the active language (the Gateway sends none).
public enum GrantSubject: Sendable, Equatable {
    /// A trusted site ("Always for this site"); `subdomains` also covers its subdomains.
    case trustedSite(host: String, subdomains: Bool)
    /// A website the agent may read from (host, no scheme).
    case origin(host: String)
    /// The standing grant for notes titled "Prep:" (meeting prep).
    case prepNotes
    /// A connector action or MCP tool, by its name.
    case named(String)
    /// A host program, in a folder, with any arguments or exactly these.
    case hostProgram(program: String, folder: String, exactArguments: Bool)
    /// A command (`argv` joined), in a folder when known.
    case command(String, folder: String?)
    /// Sending email to these recipients, from an account when known.
    case email(recipients: String, account: String?)
    /// A calendar write; the calendar id when the grant names one.
    case calendar(id: String?)
    /// Anything else: the grant key as written.
    case other(String)
}

public enum GrantStatus: Sendable, Equatable {
    case active, expired, revoked
}

public struct StandingGrant: Sendable, Equatable, Identifiable {
    public var id: String
    /// The wire kind (`new_origin`, `send_email`, ...); the screen words the ones it knows.
    public var kind: String
    /// The wire scope (`once`, `task`, `site`, `session`, `always`).
    public var scope: String
    public var subject: GrantSubject
    public var useCount: Int
    public var lastUsedAt: Date?
    public var expiresAt: Date?
    public var revokedAt: Date?

    public init(
        id: String, kind: String, scope: String, subject: GrantSubject, useCount: Int = 0,
        lastUsedAt: Date? = nil, expiresAt: Date? = nil, revokedAt: Date? = nil
    ) {
        self.id = id
        self.kind = kind
        self.scope = scope
        self.subject = subject
        self.useCount = useCount
        self.lastUsedAt = lastUsedAt
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
    }

    public func status(now: Date = .now) -> GrantStatus {
        if revokedAt != nil { return .revoked }
        if let expiresAt, expiresAt <= now { return .expired }
        return .active
    }
}

public protocol GrantsBackend: Sendable {
    /// Every standing grant, revoked ones included (`grants.list`). Throws `BackendError.refused` with the
    /// Gateway's message when this phone may not read them.
    func standingGrants() async throws -> [StandingGrant]
    /// Revokes one (`grants.revoke`). Throws `BackendError.refused` with the Gateway's message without admin.
    func revokeGrant(id: String) async throws
    /// Whether this phone holds `operator.admin`: only then is Revoke offered. The Gateway still decides.
    func canRevokeGrants() async -> Bool
}

extension GrantsBackend {
    public func standingGrants() async throws -> [StandingGrant] { [] }
    public func revokeGrant(id: String) async throws { throw BackendError.notFound }
    public func canRevokeGrants() async -> Bool { false }
}
