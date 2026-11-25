import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// A backend that records what the screen asked for and can refuse the list or the revoke.
private actor MockGrants: GrantsBackend {
    var grants: [StandingGrant]
    var admin: Bool
    var listError: BackendError?
    var revokeError: BackendError?
    private(set) var revokeCalls: [String] = []

    init(grants: [StandingGrant], admin: Bool, listError: BackendError? = nil, revokeError: BackendError? = nil) {
        self.grants = grants
        self.admin = admin
        self.listError = listError
        self.revokeError = revokeError
    }

    func standingGrants() async throws -> [StandingGrant] {
        if let listError { throw listError }
        return grants
    }

    func revokeGrant(id: String) async throws {
        revokeCalls.append(id)
        if let revokeError { throw revokeError }
        if let index = grants.firstIndex(where: { $0.id == id }) { grants[index].revokedAt = .now }
    }

    func canRevokeGrants() async -> Bool { admin }
}

@MainActor
struct StandingPermissionsModelTests {
    private func sample() -> [StandingGrant] {
        [StandingGrant(id: "g1", kind: "mcp_tool", scope: "always", subject: .named("linear.create_issue"))]
    }

    @Test func theFixtureScenarioShowsActiveExpiredAndRevokedRows() async throws {
        let model = StandingPermissionsModel(store: FixtureBackend())
        await model.load()
        let grants = try #require(model.phase.value)
        #expect(grants.count >= 5)
        #expect(grants.map { $0.status() }.contains(.expired))
        #expect(grants.map { $0.status() }.contains(.revoked))
        #expect(grants.map { $0.status() }.contains(.active))
    }

    @Test func anAdminPhoneRevokesThenTheRowReadsRevoked() async throws {
        let store = FixtureBackend()
        let model = StandingPermissionsModel(store: store)
        await model.load()
        #expect(model.isAdmin)
        let target = try #require(model.phase.value?.first { $0.id == "grt_mail" })
        #expect(target.status() == .active)
        await model.revoke(target)
        let after = try #require(model.phase.value?.first { $0.id == "grt_mail" })
        #expect(after.status() == .revoked)
        #expect(model.revokeError == nil)
        #expect(model.revoking == nil)
    }

    @Test func aPhoneWithoutAdminNeverCallsRevoke() async throws {
        let store = MockGrants(grants: sample(), admin: false)
        let model = StandingPermissionsModel(store: store)
        await model.load()
        #expect(model.isAdmin == false)
        #expect(model.phase.value?.count == 1)
        await model.revoke(sample()[0])
        #expect(await store.revokeCalls.isEmpty)
    }

    @Test func aFixturePhoneWithoutAdminIsRefusedAndNothingChanges() async throws {
        let store = FixtureBackend()
        await store.setGrantsAdmin(false)
        let model = StandingPermissionsModel(store: store)
        await model.load()
        #expect(model.isAdmin == false)
        await #expect(throws: BackendError.refused("This phone needs admin access to revoke.")) {
            try await store.revokeGrant(id: "grt_mail")
        }
        let after = try await store.standingGrants().first { $0.id == "grt_mail" }
        #expect(after?.status() == .active)
        #expect(after?.revokedAt == nil)
    }

    @Test func aRefusedRevokeShowsTheGatewaysWordsInlineAndKeepsTheList() async throws {
        let store = MockGrants(grants: sample(), admin: true, revokeError: .refused("Needs admin access."))
        let model = StandingPermissionsModel(store: store)
        await model.load()
        await model.revoke(sample()[0])
        let message = try #require(model.revokeError)
        #expect(message.contains("Needs admin access."))
        #expect(message.contains("linear.create_issue"))
        #expect(model.phase.value?.first?.status() == .active)
    }

    @Test func aRefusedListIsAPlainNoteNotTheGatewaysWording() async throws {
        let store = MockGrants(grants: [], admin: false, listError: .refused("forbidden: scope"))
        let model = StandingPermissionsModel(store: store)
        await model.load()
        guard case .failed(let message) = model.phase else { Issue.record("expected failed"); return }
        #expect(!message.contains("forbidden"))
    }

    @Test func revokeReadsTheListAgainAndAnErrorClearsOnTheNextTry() async throws {
        let store = MockGrants(grants: sample(), admin: true, revokeError: .unreachable)
        let model = StandingPermissionsModel(store: store)
        await model.load()
        await model.revoke(sample()[0])
        #expect(model.revokeError != nil)
        await store.setRevokeError(nil)
        await model.revoke(sample()[0])
        #expect(model.revokeError == nil)
        #expect(model.phase.value?.first?.status() == .revoked)
        #expect(await store.revokeCalls == ["g1", "g1"])
    }

    @Test func aRevokeThatSucceededStaysRevokedWhenTheRereadFails() async throws {
        let store = MockGrants(grants: sample(), admin: true)
        let model = StandingPermissionsModel(store: store)
        await model.load()
        await store.setListError(.unreachable)
        await model.revoke(sample()[0])
        #expect(model.phase.value?.first?.status() == .revoked)
    }
}

extension MockGrants {
    fileprivate func setListError(_ error: BackendError?) { listError = error }
    fileprivate func setRevokeError(_ error: BackendError?) { revokeError = error }
}
