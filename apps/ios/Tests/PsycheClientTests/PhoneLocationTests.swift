import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import struct PsycheProtocol.WireReqFrame
import PsycheShared
import PsycheStore
import PsycheWire
import Testing

@testable import PsycheClient

/// A stand-in for CoreLocation: nothing here can show a permission prompt or read a real position.
final class FakeLocationProvider: LocationProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var _status: LocationAuthorization
    private var _promptAnswer: LocationAuthorization
    private var _fixes = 0
    private var _prompts = 0
    var fix: Result<LocationFix, LocationFailure> = .success(
        LocationFix(latitude: 52.52, longitude: 13.405, accuracyMeters: 12.5, timestamp: Date(timeIntervalSince1970: 1_800_000_000)))
    var name: String? = "Alexanderplatz, Berlin"
    /// A fix that never arrives on its own (honours cancellation).
    var hang = false

    init(status: LocationAuthorization = .notDetermined, promptAnswer: LocationAuthorization = .authorized) {
        _status = status
        _promptAnswer = promptAnswer
    }

    var status: LocationAuthorization { get { lock.withLock { _status } } set { lock.withLock { _status = newValue } } }
    var prompts: Int { lock.withLock { _prompts } }
    var fixes: Int { lock.withLock { _fixes } }

    func authorization() async -> LocationAuthorization { status }

    func requestWhenInUseAuthorization() async -> LocationAuthorization {
        lock.withLock {
            _prompts += 1
            _status = _promptAnswer
            return _status
        }
    }

    func currentFix() async throws -> LocationFix {
        lock.withLock { _fixes += 1 }
        if hang { try await Task.sleep(for: .seconds(60)) }
        return try fix.get()
    }

    func placeName(for fix: LocationFix) async -> String? { name }
}

/// Collects what the phone declared and delivered, in order.
final class LocationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _declared: [[String]] = []
    private var _delivered: [(String, JSONValue)] = []
    var declared: [[String]] { lock.withLock { _declared } }
    var delivered: [(String, JSONValue)] { lock.withLock { _delivered } }
    func declare(_ caps: [String]) { lock.withLock { _declared.append(caps) } }
    func deliver(_ id: String, _ result: JSONValue) { lock.withLock { _delivered.append((id, result)) } }
}

struct PhoneLocationNodeTests {
    func node(
        _ provider: FakeLocationProvider, foreground: Bool = true, timeout: Duration = .seconds(2)
    ) -> (PhoneLocationNode, ForegroundState) {
        let state = ForegroundState()
        state.set(foreground)
        return (PhoneLocationNode(provider: provider, foreground: state, timeout: timeout), state)
    }

    static func invoke(_ id: String = "inv_1", capability: String = "location.current") -> JSONValue {
        .object(["invocationId": .string(id), "capability": .string(capability), "params": .object([:])])
    }

    /// Runs `answer` the way a `node.invoke` would, and returns the `node.result` params.
    func result(_ node: PhoneLocationNode, _ id: String = "inv_1") async -> JSONValue {
        await node.answer(invocationId: id)
    }

    // MARK: Off by default

    @Test func offByDefaultNothingIsAskedAndNothingIsDeclared() async {
        let provider = FakeLocationProvider()
        let (node, _) = node(provider)
        let recorder = LocationRecorder()
        await node.connected(declare: { recorder.declare($0) })
        #expect(recorder.declared == [[]])
        #expect(provider.prompts == 0)
        let answer = await result(node)
        #expect(answer["ok"] == .bool(false))
        #expect(answer["error"]?["code"]?.stringValue == "forbidden")
        #expect(answer["error"]?["message"]?.stringValue?.contains("isn't sharing location right now") == true)
        #expect(provider.fixes == 0)
    }

    @Test func turningOnAsksIOSOnceThenDeclaresTheCapability() async {
        let provider = FakeLocationProvider(status: .notDetermined, promptAnswer: .authorized)
        let (node, _) = node(provider)
        let recorder = LocationRecorder()
        await node.connected(declare: { recorder.declare($0) })
        #expect(await node.setSharing(true) == .enabled)
        #expect(provider.prompts == 1)
        #expect(recorder.declared.last == ["location.current"])
        // Already allowed: switching off and on again does not prompt again.
        #expect(await node.setSharing(false) == .disabled)
        #expect(await node.setSharing(true) == .enabled)
        #expect(provider.prompts == 1)
    }

    @Test func aRefusedPermissionLeavesSharingOffAndDeclaresNothing() async {
        let provider = FakeLocationProvider(status: .notDetermined, promptAnswer: .denied)
        let (node, _) = node(provider)
        let recorder = LocationRecorder()
        await node.connected(declare: { recorder.declare($0) })
        #expect(await node.setSharing(true) == .permissionDenied)
        #expect(recorder.declared.allSatisfy { $0.isEmpty })
        #expect(await node.isSharing() == false)
    }

    @Test func permissionAlreadyOffInIOSSettingsDoesNotPromptAgain() async {
        let provider = FakeLocationProvider(status: .denied)
        let (node, _) = node(provider)
        #expect(await node.setSharing(true) == .permissionDenied)
        #expect(provider.prompts == 0)
    }

    @Test func turningOffWithdrawsAtOnce() async {
        let provider = FakeLocationProvider(status: .authorized)
        let (node, _) = node(provider)
        let recorder = LocationRecorder()
        await node.connected(declare: { recorder.declare($0) })
        _ = await node.setSharing(true)
        #expect(recorder.declared.last == ["location.current"])
        _ = await node.setSharing(false)
        #expect(recorder.declared.last == [])
        let answer = await result(node)
        #expect(answer["ok"] == .bool(false))
        #expect(provider.fixes == 0)
    }

    @Test func permissionTakenAwayLaterWithdrawsAtTheNextSyncAndRefusesRequests() async {
        let provider = FakeLocationProvider(status: .authorized)
        let (node, _) = node(provider)
        _ = await node.setSharing(true)
        provider.status = .denied  // switched off in iOS Settings
        #expect(await node.declaredCapabilities() == [])
        let answer = await result(node)
        #expect(answer["error"]?["code"]?.stringValue == "forbidden")
        #expect(answer["error"]?["message"]?.stringValue?.contains("permission") == true)
        #expect(provider.fixes == 0)
    }

    @Test func theStoredPreferenceIsRestoredOnceAndOnlyDeclaredWhileAllowed() async {
        let provider = FakeLocationProvider(status: .authorized)
        let (node, _) = node(provider)
        await node.restore(wanted: true)
        await node.restore(wanted: false)  // a later read of the file never overrides the live switch
        #expect(await node.isSharing())
        let denied = FakeLocationProvider(status: .denied)
        let (other, _) = self.node(denied)
        await other.restore(wanted: true)
        #expect(await other.declaredCapabilities() == [])
        #expect(denied.prompts == 0)  // restoring never prompts
    }

    // MARK: Answering

    @Test func answersOneFixWithEverythingTheAgentNeeds() async throws {
        let provider = FakeLocationProvider(status: .authorized)
        let (node, _) = node(provider)
        _ = await node.setSharing(true)
        let answer = await result(node, "inv_9")
        #expect(answer["invocationId"]?.stringValue == "inv_9")
        #expect(answer["ok"] == .bool(true))
        let body = try #require(answer["result"])
        #expect(body["latitude"] == .number(52.52))
        #expect(body["longitude"] == .number(13.405))
        #expect(body["accuracyMeters"] == .number(12.5))
        #expect(body["placeName"]?.stringValue == "Alexanderplatz, Berlin")
        let stamp = try #require(body["timestamp"]?.stringValue)
        #expect(IdentityCheck.parseDate(stamp) == Date(timeIntervalSince1970: 1_800_000_000))
        #expect(provider.fixes == 1)
    }

    @Test func noPlaceNameIsLeftOutNotEmpty() async {
        let provider = FakeLocationProvider(status: .authorized)
        provider.name = "  "
        let (node, _) = node(provider)
        _ = await node.setSharing(true)
        let answer = await result(node)
        #expect(answer["ok"] == .bool(true))
        #expect(answer["result"]?["placeName"] == nil)
    }

    @Test func inTheBackgroundThePhoneAnswersWithAClearErrorAndTakesNoFix() async {
        let provider = FakeLocationProvider(status: .authorized)
        let (node, state) = node(provider, foreground: false)
        _ = await node.setSharing(true)
        let answer = await result(node)
        #expect(answer["ok"] == .bool(false))
        #expect(answer["error"]?["code"]?.stringValue == "unavailable")
        #expect(answer["error"]?["message"]?.stringValue == "The phone isn't sharing location right now: Psyche isn't open on the phone.")
        #expect(provider.fixes == 0)
        // Positive control: the same request succeeds once Psyche is on screen.
        state.set(true)
        #expect(await result(node)["ok"] == .bool(true))
        #expect(provider.fixes == 1)
    }

    @Test func aFixThatNeverComesTimesOutAndOneThatFailsSaysSo() async {
        let slow = FakeLocationProvider(status: .authorized)
        slow.hang = true
        let (node, _) = node(slow, timeout: .milliseconds(80))
        _ = await node.setSharing(true)
        let timedOut = await result(node)
        #expect(timedOut["error"]?["code"]?.stringValue == "timeout")

        let failing = FakeLocationProvider(status: .authorized)
        failing.fix = .failure(.unavailable)
        let (other, _) = self.node(failing)
        _ = await other.setSharing(true)
        #expect(await result(other)["error"]?["code"]?.stringValue == "unavailable")

        let unknownAccuracy = FakeLocationProvider(status: .authorized)
        unknownAccuracy.fix = .success(LocationFix(latitude: 1, longitude: 2, accuracyMeters: -1, timestamp: .now))
        let (third, _) = self.node(unknownAccuracy)
        _ = await third.setSharing(true)
        #expect(await result(third)["ok"] == .bool(false))
    }

    // MARK: node.invoke

    @Test func acceptsOnlyLocationCurrentAndDeliversTheResultAfterwards() async throws {
        let provider = FakeLocationProvider(status: .authorized)
        let (node, _) = node(provider)
        _ = await node.setSharing(true)
        let recorder = LocationRecorder()
        let accepted = await node.accept(params: Self.invoke("inv_5"), deliver: { recorder.deliver($0, $1) })
        #expect(try accepted.get() == .object(["accepted": .bool(true)]))
        for _ in 0..<100 where recorder.delivered.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        let delivered = try #require(recorder.delivered.first)
        #expect(delivered.0 == "inv_5")
        #expect(delivered.1["ok"] == .bool(true))

        let other = await node.accept(params: Self.invoke(capability: "contacts.read"), deliver: { recorder.deliver($0, $1) })
        guard case .failure(let error) = other else { Issue.record("accepted a capability it does not offer"); return }
        #expect(error.code == "not_found")
        let missing = await node.accept(params: .object(["capability": "location.current"]), deliver: { recorder.deliver($0, $1) })
        guard case .failure(let bad) = missing else { Issue.record("accepted without an id"); return }
        #expect(bad.code == "invalid_params")
        #expect(provider.fixes == 1)
    }
}

/// The phone against a scripted Gateway: the switch, the declaration, and the answer to `node.invoke`.
struct PhoneLocationClientTests {
    final class Rig: @unchecked Sendable {
        let gateway: FakeGateway
        let provider: FakeLocationProvider
        let client: GatewayClient
        let backend: GatewayBackend
        let dir: URL

        init(provider: FakeLocationProvider = FakeLocationProvider()) {
            let gateway = FakeGateway()
            self.gateway = gateway
            self.provider = provider
            dir = FileManager.default.temporaryDirectory.appendingPathComponent("loc-\(UUID().uuidString)")
            client = GatewayClient(dependencies: GatewayClientDependencies(
                endpointStore: EndpointStore(directory: dir), identityStore: DeviceIdentityStore(store: MemorySecretStore()),
                outbox: Outbox(directory: dir), transportFactory: { _, _ in gateway.makeTransport() },
                reachability: FakeReachability(resolvesHost: true, local: true),
                backoff: Backoff(base: 0.02, cap: 0.05, random: { 0 }), deviceName: "Test iPhone", stateDirectory: dir,
                backgroundGrace: .milliseconds(80), pendingRecheck: .milliseconds(40), shareInbox: nil,
                libraryCache: dir.appendingPathComponent("LibraryCache"), locationProvider: provider))
            backend = GatewayBackend(client: client)
        }
        deinit { try? FileManager.default.removeItem(at: dir) }

        func goLive() async throws {
            await client.setActive(true)
            await client.beginPairing(try GatewayClientTests.link())
            #expect(await GatewayClientTests.wait(client) { $0 == .live } == .live)
        }

        /// Waits for `condition` on what the Gateway received.
        func eventually(_ condition: @Sendable () -> Bool) async throws {
            for _ in 0..<150 where !condition() { try await Task.sleep(for: .milliseconds(20)) }
        }

        var declarations: [[String]] {
            gateway.received.filter { $0.method == "phone.capabilities.set" }
                .map { ($0.params?["capabilities"].flatMap { v -> [String]? in
                    if case .array(let items) = v { items.compactMap(\.stringValue) } else { nil }
                }) ?? [] }
        }
    }

    @Test func aFreshPhoneOffersNothingAndNeverAsksIOS() async throws {
        let rig = Rig()
        try await rig.goLive()
        try await rig.eventually { !rig.declarations.isEmpty }
        #expect(rig.declarations == [[]])
        #expect(rig.provider.prompts == 0)
        #expect(try await rig.backend.settings().shareLocation == false)
    }

    @Test func theSwitchAsksIOSDeclaresAndTheGatewayCanAskWhereThePhoneIs() async throws {
        let rig = Rig()
        rig.gateway.on("phone.capabilities.set") { _ in .success(.object(["capabilities": .array(["location.current"])])) }
        rig.gateway.on("node.result") { _ in .success(.object(["ok": .bool(true)])) }
        try await rig.goLive()
        #expect(try await rig.backend.setLocationSharing(true) == .enabled)
        #expect(rig.provider.prompts == 1)
        #expect(rig.declarations.last == ["location.current"])
        #expect(try await rig.backend.settings().shareLocation == true)

        // The Gateway asks; the phone accepts at once and sends the fix as node.result.
        rig.gateway.lastTransport?.push(request: WireReqFrame(
            id: "gw-1", method: "node.invoke",
            params: .object(["invocationId": "inv_1", "capability": "location.current", "params": .object([:])])))
        try await rig.eventually { !rig.gateway.responses.isEmpty && rig.gateway.received.contains { $0.method == "node.result" } }
        let accepted = try #require(rig.gateway.responses.first)
        #expect(accepted.id == "gw-1" && accepted.ok)
        let result = try #require(rig.gateway.received.first { $0.method == "node.result" }?.params)
        #expect(result["invocationId"]?.stringValue == "inv_1")
        #expect(result["ok"] == .bool(true))
        #expect(result["result"]?["latitude"] == .number(52.52))
    }

    @Test func switchingOffWithdrawsAndALaterRequestIsRefused() async throws {
        let rig = Rig(provider: FakeLocationProvider(status: .authorized))
        rig.gateway.on("phone.capabilities.set") { _ in .success(.object(["capabilities": .array([])])) }
        rig.gateway.on("node.result") { _ in .success(.object(["ok": .bool(true)])) }
        try await rig.goLive()
        _ = try await rig.backend.setLocationSharing(true)
        #expect(try await rig.backend.setLocationSharing(false) == .disabled)
        #expect(rig.declarations.last == [])
        #expect(try await rig.backend.settings().shareLocation == false)
        rig.gateway.lastTransport?.push(request: WireReqFrame(
            id: "gw-2", method: "node.invoke",
            params: .object(["invocationId": "inv_2", "capability": "location.current", "params": .object([:])])))
        try await rig.eventually { rig.gateway.received.contains { $0.method == "node.result" } }
        let result = try #require(rig.gateway.received.first { $0.method == "node.result" }?.params)
        #expect(result["ok"] == .bool(false))
        #expect(rig.provider.fixes == 0)
    }

    @Test func aRefusedPermissionIsReportedAndNothingIsSaved() async throws {
        let rig = Rig(provider: FakeLocationProvider(status: .notDetermined, promptAnswer: .denied))
        try await rig.goLive()
        #expect(try await rig.backend.setLocationSharing(true) == .permissionDenied)
        #expect(try await rig.backend.settings().shareLocation == false)
        #expect(rig.declarations.allSatisfy { $0.isEmpty })
    }

    @Test func theSwitchIsRememberedAcrossConnectsAndReadsOffWhenIOSPermissionGoes() async throws {
        let rig = Rig(provider: FakeLocationProvider(status: .authorized))
        try await rig.goLive()
        _ = try await rig.backend.setLocationSharing(true)
        #expect(try await rig.backend.settings().shareLocation == true)
        rig.provider.status = .denied
        #expect(try await rig.backend.settings().shareLocation == false)
        // The saved choice is untouched by a plain settings save (it has its own call).
        let settings = try await rig.backend.settings()
        try await rig.backend.updateSettings(settings)
        rig.provider.status = .authorized
        #expect(try await rig.backend.settings().shareLocation == true)
    }

    @Test func aRequestBeforeThePhoneHasPairedIsNotAnswered() async throws {
        let gateway = FakeGateway()
        let conn = GatewayConnection(
            endpoint: ConnectionTests.endpoint(), identity: DeviceIdentity(), deviceName: "iPhone", transport: gateway.makeTransport())
        await conn.setInboundHandler { _ in .success(.object(["accepted": .bool(true)])) }
        let transport = try #require(gateway.lastTransport)
        transport.push(request: WireReqFrame(id: "gw-1", method: "node.invoke", params: .object([:])))
        try await Task.sleep(for: .milliseconds(100))
        #expect(gateway.responses.isEmpty)
    }
}
