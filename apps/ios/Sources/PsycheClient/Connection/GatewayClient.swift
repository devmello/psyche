import Foundation
import PsycheShared
import PsycheStore
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireEventFrame
import PsycheWire

/// Everything `GatewayClient` needs from the outside, so tests can swap the socket, the clock and the disk.
public struct GatewayClientDependencies: Sendable {
    public var endpointStore: EndpointStore
    public var identityStore: DeviceIdentityStore
    public var outbox: Outbox
    public var transportFactory: TransportFactory
    public var reachability: any Reachability
    public var backoff: Backoff
    public var deviceName: String
    /// Where the last-seen `stateVersion` is kept (nil: memory only).
    public var stateDirectory: URL?
    /// How long a backgrounded app keeps its socket (companion §2.3: iOS suspends it soon anyway).
    public var backgroundGrace: Duration
    /// How often a pending (not yet approved) phone asks again.
    public var pendingRecheck: Duration
    /// Run on revoke, after keys and outbox are wiped: the cache owner clears its files here.
    public var onWipe: @Sendable () async -> Void

    public init(
        endpointStore: EndpointStore = .standard(),
        identityStore: DeviceIdentityStore = DeviceIdentityStore(),
        outbox: Outbox = Outbox(directory: AppGroup.dataDirectory),
        transportFactory: @escaping TransportFactory = { URLSessionTransport(url: $0, trust: $1) },
        reachability: any Reachability = SystemReachability(),
        backoff: Backoff = Backoff(),
        deviceName: String = "iPhone",
        stateDirectory: URL? = AppGroup.dataDirectory,
        backgroundGrace: Duration = .seconds(5),
        pendingRecheck: Duration = .seconds(5),
        onWipe: @escaping @Sendable () async -> Void = {}
    ) {
        self.endpointStore = endpointStore
        self.identityStore = identityStore
        self.outbox = outbox
        self.transportFactory = transportFactory
        self.reachability = reachability
        self.backoff = backoff
        self.deviceName = deviceName
        self.stateDirectory = stateDirectory
        self.backgroundGrace = backgroundGrace
        self.pendingRecheck = pendingRecheck
        self.onWipe = onWipe
    }
}

/// Owns the phone's one Gateway connection for the life of the app: connects when the scene is
/// active, reconnects with jittered backoff, closes shortly after backgrounding, classifies why the
/// Gateway cannot be reached, handles `pending`/`revoked`/identity refusal, flushes the outbox, and
/// turns Gateway events into `LiveEvent`s. The UI sees `ConnectionState` and `LiveEvent`s only.
public actor GatewayClient {
    private let deps: GatewayClientDependencies

    private var endpoint: GatewayEndpoint?
    private var setupToken: String?
    private var state: ConnectionState = .unpaired
    private var connection: GatewayConnection?
    private var runLoop: Task<Void, Never>?
    private var backgroundTimer: Task<Void, Never>?
    private var active = false
    private var resync: Resync
    private var mapper: EventMapper?

    private var stateSubscribers: [UUID: AsyncStream<ConnectionState>.Continuation] = [:]
    private var eventSubscribers: [UUID: AsyncStream<LiveEvent>.Continuation] = [:]
    private var failureSubscribers: [UUID: AsyncStream<String>.Continuation] = [:]

    public init(dependencies: GatewayClientDependencies) {
        deps = dependencies
        resync = Resync(lastStateVersion: Self.loadStateVersion(dependencies.stateDirectory))
        endpoint = dependencies.endpointStore.load()
        state = endpoint == nil ? .unpaired : .connecting
    }

    // MARK: - What the UI and backends read

    public var currentState: ConnectionState { state }
    public var pairedEndpoint: GatewayEndpoint? { endpoint }

    /// States, starting with the current one. One stream per subscriber.
    public nonisolated func states() -> AsyncStream<ConnectionState> {
        let (stream, continuation) = AsyncStream<ConnectionState>.makeStream(bufferingPolicy: .bufferingNewest(8))
        let id = UUID()
        continuation.onTermination = { _ in Task { await self.removeStateSubscriber(id) } }
        Task { await self.addStateSubscriber(id, continuation) }
        return stream
    }

    public nonisolated func liveEvents() -> AsyncStream<LiveEvent> {
        let (stream, continuation) = AsyncStream<LiveEvent>.makeStream(bufferingPolicy: .bufferingNewest(512))
        let id = UUID()
        continuation.onTermination = { _ in Task { await self.removeEventSubscriber(id) } }
        Task { await self.addEventSubscriber(id, continuation) }
        return stream
    }

    /// Messages for the pairing screen ("pairing link expired or already used").
    public nonisolated func pairingFailures() -> AsyncStream<String> {
        let (stream, continuation) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingNewest(4))
        let id = UUID()
        continuation.onTermination = { _ in Task { await self.removeFailureSubscriber(id) } }
        Task { await self.addFailureSubscriber(id, continuation) }
        return stream
    }

    private func addStateSubscriber(_ id: UUID, _ c: AsyncStream<ConnectionState>.Continuation) {
        stateSubscribers[id] = c
        c.yield(state)
    }
    private func removeStateSubscriber(_ id: UUID) { stateSubscribers[id] = nil }
    private func addEventSubscriber(_ id: UUID, _ c: AsyncStream<LiveEvent>.Continuation) { eventSubscribers[id] = c }
    private func removeEventSubscriber(_ id: UUID) { eventSubscribers[id] = nil }
    private func addFailureSubscriber(_ id: UUID, _ c: AsyncStream<String>.Continuation) { failureSubscribers[id] = c }
    private func removeFailureSubscriber(_ id: UUID) { failureSubscribers[id] = nil }

    private func set(_ new: ConnectionState) {
        guard new != state else { return }
        state = new
        for c in stateSubscribers.values { c.yield(new) }
    }

    private func publish(_ event: LiveEvent) {
        for c in eventSubscribers.values { c.yield(event) }
    }

    // MARK: - Lifecycle

    /// `scenePhase == .active` connects; `.background` closes about five seconds later.
    public func setActive(_ isActive: Bool) {
        active = isActive
        if isActive {
            backgroundTimer?.cancel()
            backgroundTimer = nil
            startRunLoopIfNeeded()
        } else {
            backgroundTimer?.cancel()
            backgroundTimer = Task { [grace = deps.backgroundGrace] in
                try? await Task.sleep(for: grace)
                guard !Task.isCancelled else { return }
                self.closeForBackground()
            }
        }
    }

    private func closeForBackground() {
        guard !active else { return }
        runLoop?.cancel()
        runLoop = nil
        let old = connection
        connection = nil
        persistStateVersion()
        Task { await old?.close() }
        if case .live = state { set(.connecting) }
    }

    private func startRunLoopIfNeeded() {
        guard runLoop == nil, active, endpoint != nil else { return }
        switch state {
        case .refused, .revoked, .unpaired: return
        default: break
        }
        runLoop = Task { await self.run() }
    }

    // MARK: - Pairing

    /// Pins the key from `link` and connects with its setup token. The endpoint is stored only after
    /// the Gateway proved it holds that key (inside `run`, on `pending` or `paired`).
    public func beginPairing(_ link: PairingLink) {
        runLoop?.cancel()
        runLoop = nil
        let old = connection
        connection = nil
        Task { await old?.close() }
        endpoint = link.endpoint
        setupToken = link.setupToken
        set(.connecting)
        active = true
        startRunLoopIfNeeded()
    }

    /// The owner backed out of a pairing in progress.
    public func cancelPairing() {
        runLoop?.cancel()
        runLoop = nil
        let old = connection
        connection = nil
        Task { await old?.close() }
        if deps.endpointStore.load() == nil { endpoint = nil }
        setupToken = nil
        set(.unpaired)
    }

    /// Keys, endpoint, outbox and cache are wiped; the UI returns to pairing.
    public func revoke() async {
        runLoop?.cancel()
        runLoop = nil
        let old = connection
        connection = nil
        await old?.close()
        try? await deps.identityStore.wipe()
        deps.endpointStore.clear()
        await deps.outbox.wipe()
        if let dir = deps.stateDirectory { try? FileManager.default.removeItem(at: dir.appendingPathComponent("state.json")) }
        resync = Resync(lastStateVersion: nil)
        endpoint = nil
        setupToken = nil
        await deps.onWipe()
        set(.revoked)
    }

    /// The owner chose to start over from the refused or revoked screen.
    public func forgetGateway() async {
        await revoke()
        set(.unpaired)
    }

    // MARK: - Calls

    /// A call on the live connection. Throws `BackendError.unreachable` when there is none.
    public func call(
        _ method: String, params: JSONValue? = nil, idempotencyKey: String? = nil, timeout: Duration = .seconds(20)
    ) async throws -> JSONValue {
        guard case .live = state, let connection else { throw BackendError.unreachable }
        do {
            return try await connection.call(method, params: params, idempotencyKey: idempotencyKey, timeout: timeout)
        } catch {
            throw Self.backendError(error)
        }
    }

    public static func backendError(_ error: any Error) -> BackendError {
        if let backend = error as? BackendError { return backend }
        guard let failure = error as? ConnectionFailure else { return .unreachable }
        switch failure {
        case .remote(let wire):
            if wire.code == "not_found" { return .notFound }
            return .refused(wire.message)
        case .timeout, .transport, .closed, .identityMismatch, .protocolError: return .unreachable
        }
    }

    /// Queues a write and sends it now when connected. `.queued` means the Gateway has not acknowledged it yet.
    public func submit(_ entry: OutboxEntry) async -> Outbox.Delivery {
        await deps.outbox.enqueue(entry)
        guard case .live = state else { return .queued }
        let outcomes = await flushOutbox()
        return outcomes[entry.id] ?? .queued
    }

    @discardableResult
    private func flushOutbox() async -> [String: Outbox.Delivery] {
        await deps.outbox.flush { [self] entry in
            guard case .live = await self.currentState, let connection = await self.connection else {
                throw Outbox.OutboxSendError.retryLater
            }
            do {
                return try await connection.call(entry.method, params: entry.params, idempotencyKey: entry.id)
            } catch ConnectionFailure.remote(let wire) {
                if wire.retryable == true || wire.code == "unavailable" || wire.code == "rate_limited" {
                    throw Outbox.OutboxSendError.retryLater
                }
                throw Outbox.OutboxSendError.rejected(wire.message)
            } catch {
                throw Outbox.OutboxSendError.retryLater
            }
        }
    }

    // MARK: - The run loop

    private func run() async {
        var attempt = 0
        while !Task.isCancelled, active, let endpoint {
            if case .unreachable = state {} else if case .pending = state {} else { set(.connecting) }
            let token = setupToken
            let outcome = await connectOnce(endpoint: endpoint, setupToken: token)
            if Task.isCancelled { return }
            switch outcome {
            case .live(let events):
                attempt = 0
                setupToken = nil
                await consume(events)
                if Task.isCancelled || !active { return }
                try? await Task.sleep(for: .seconds(deps.backoff.delay(attempt: 0)))
            case .pending(let code):
                setupToken = nil
                set(.pending(PendingApproval(code: Self.groupedCode(code), endpoint: endpoint, deviceName: deps.deviceName)))
                try? await Task.sleep(for: deps.pendingRecheck)
            case .denied(let reason, let tokenInvalid):
                var wasPairing = token != nil
                if case .pending = state { wasPairing = true }
                await handleDenied(reason: reason, tokenInvalid: tokenInvalid, wasPairing: wasPairing)
                return
            case .refused:
                set(.refused(.identityMismatch))
                return
            case .unreachable:
                let reason = await UnreachableClassifier.classify(endpoint, reachability: deps.reachability)
                if Task.isCancelled { return }
                set(.unreachable(reason))
                try? await Task.sleep(for: .seconds(deps.backoff.delay(attempt: attempt)))
                attempt += 1
            }
        }
    }

    private enum Attempt {
        case live(AsyncStream<WireEventFrame>)
        case pending(code: String)
        case denied(String, tokenInvalid: Bool)
        case refused
        case unreachable
    }

    private func connectOnce(endpoint: GatewayEndpoint, setupToken: String?) async -> Attempt {
        guard let url = URLSessionTransport.socketURL(forOrigin: endpoint.url) else { return .unreachable }
        let identity: DeviceIdentity
        do { identity = try await deps.identityStore.identity() } catch { return .unreachable }
        // A self-signed certificate is accepted for capture on the local network only; Tailscale and everything
        // else needs a chain the system trusts.
        let transport = deps.transportFactory(
            url, TransportTrust(allowSelfSigned: endpoint.transport == .lan, pinnedSPKI: endpoint.lanCertSpki))
        let connection = GatewayConnection(
            endpoint: endpoint, identity: identity, deviceName: deps.deviceName, transport: transport)
        do {
            let outcome = try await connection.handshake(setupToken: setupToken)
            switch outcome {
            case .paired(let deviceID, _, let stateVersion):
                await pin(connection, to: endpoint)
                self.connection = connection
                self.mapper = EventMapper(lookupQuestion: { [weak connection] id in
                    guard let connection,
                          let payload = try? await connection.call("questions.get", params: .obj(["inputRequestId": .string(id)]))
                    else { return nil }
                    return payload["inputRequest"].flatMap(ChatMapping.question(from:))
                })
                self.ownDeviceID = deviceID
                set(.live)
                if resync.connected(stateVersion: stateVersion) { publish(.resynced) }
                persistStateVersion()
                Task { await self.flushOutbox() }
                return .live(connection.events)
            case .pending(let code):
                await pin(connection, to: endpoint)  // the Gateway proved the key (and certificate) it is pinned by
                await connection.close()
                return .pending(code: code)
            case .denied(let reason, let tokenInvalid):
                await connection.close()
                return .denied(reason, tokenInvalid: tokenInvalid)
            }
        } catch ConnectionFailure.identityMismatch {
            return .refused
        } catch {
            await connection.close()
            return .unreachable
        }
    }

    /// Stores the endpoint with what the Gateway just proved: its key (replacing the link's fingerprint as the pin)
    /// and, on the local network, the certificate it served. Only a connection that passed `IdentityCheck` gets here.
    private func pin(_ connection: GatewayConnection, to endpoint: GatewayEndpoint) async {
        var pinned = endpoint
        if let proven = await connection.proven {
            pinned.identityKey = proven.key
            if pinned.lanCertSpki == nil { pinned.lanCertSpki = proven.certSPKI }
        }
        self.endpoint = pinned
        try? deps.endpointStore.save(pinned)
    }

    private var ownDeviceID = ""

    private func consume(_ events: AsyncStream<WireEventFrame>) async {
        for await frame in events {
            if resync.observed(seq: frame.seq, stateVersion: frame.stateVersion) { publish(.resynced) }
            guard var mapper else { continue }
            let (mapped, effect) = await mapper.map(frame, ownDeviceID: ownDeviceID)
            self.mapper = mapper
            for event in mapped { publish(event) }
            if effect == .thisDeviceRevoked {
                await revoke()
                return
            }
        }
        // The socket closed. Cached content stays readable; the loop reconnects.
        connection = nil
        persistStateVersion()
    }

    /// `denied` on a reconnect of a paired phone means the device was revoked (or forgotten): wipe and
    /// return to pairing. `denied` while pairing is a message for the pairing screen.
    private func handleDenied(reason: String, tokenInvalid: Bool, wasPairing: Bool) async {
        let lower = reason.lowercased()
        // The Gateway's own words for a spent link say "revoked" too ("used, expired or was revoked"), so its
        // machine-readable code decides first: that is about the link, never about this device.
        if !tokenInvalid && (lower.contains("revoked") || !wasPairing) {
            await revoke()
            return
        }
        // A pairing link that expired, was used, or never existed all read the same on the wire.
        let message = tokenInvalid || lower.contains("link") || lower.contains("token")
            ? "That pairing link expired or was already used. Make a new link on your Mac."
            : "Your Mac didn't accept this phone: \(reason)"
        for c in failureSubscribers.values { c.yield(message) }
        deps.endpointStore.clear()
        endpoint = nil
        setupToken = nil
        set(.unpaired)
    }

    static func groupedCode(_ code: String) -> String {
        let digits = code.filter { !$0.isWhitespace }
        guard digits.count == 6 else { return code }
        return "\(digits.prefix(3)) \(digits.suffix(3))"
    }

    // MARK: - State version persistence

    private static func loadStateVersion(_ dir: URL?) -> Int? {
        guard let dir, let data = try? Data(contentsOf: dir.appendingPathComponent("state.json")),
              let value = try? JSONDecoder().decode([String: Int].self, from: data) else { return nil }
        return value["stateVersion"]
    }

    private func persistStateVersion() {
        guard let dir = deps.stateDirectory, let version = resync.lastStateVersion else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? JSONEncoder().encode(["stateVersion": version]).write(to: dir.appendingPathComponent("state.json"), options: .atomic)
    }
}
