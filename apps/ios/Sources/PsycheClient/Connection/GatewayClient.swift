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
    /// The share extension's inbox, wiped with the rest when the pairing ends or the pinned Gateway changes.
    public var shareInbox: ShareInbox?
    /// Run on revoke, after keys and outbox are wiped: the cache owner clears its files here.
    public var onWipe: @Sendable () async -> Void
    /// Where downloaded Library files live (Quick Look); removed with the rest on revoke.
    public var libraryCache: URL

    public static var defaultLibraryCache: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("psyche-library", isDirectory: true)
    }

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
        shareInbox: ShareInbox? = ShareInbox.shared,
        onWipe: @escaping @Sendable () async -> Void = {},
        libraryCache: URL = GatewayClientDependencies.defaultLibraryCache
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
        self.shareInbox = shareInbox
        self.onWipe = onWipe
        self.libraryCache = libraryCache
    }
}

/// Owns the phone's one Gateway connection for the life of the app: connects when the scene is
/// active, reconnects with jittered backoff, closes shortly after backgrounding, classifies why the
/// Gateway cannot be reached, handles `pending`/`revoked`/identity refusal, flushes the outbox, and
/// turns Gateway events into `LiveEvent`s. The UI sees `ConnectionState` and `LiveEvent`s only.
public actor GatewayClient {
    private let deps: GatewayClientDependencies

    private var endpoint: GatewayEndpoint?
    /// The working pairing, kept aside while a new link is being tried; put back if the attempt fails.
    private var previousEndpoint: GatewayEndpoint?
    /// A pairing attempt (link scanned, Gateway not yet proven paired) is under way.
    private var pairingInProgress = false
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

    /// This phone's id, name and the scopes the Gateway granted at the last connect (empty before the first).
    public var ownIdentity: (deviceID: String, name: String, scopes: [String]) { (ownDeviceID, deps.deviceName, ownScopes) }

    /// Where the phone's small durable files live (settings, last-seen state); nil in memory-only tests.
    public nonisolated var dataDirectory: URL? { deps.stateDirectory }

    /// Where downloaded Library files are kept.
    public nonisolated var libraryCache: URL { deps.libraryCache }

    /// Lets the backend announce a change it caused itself (a finished upload) to everything listening.
    public func publishLive(_ event: LiveEvent) { publish(event) }

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
        // A working pairing stays on disk and in `previousEndpoint` until the new Gateway is proven and paired,
        // so a link that fails (expired, denied, unreachable, cancelled) costs nothing.
        if previousEndpoint == nil, let current = endpoint, !current.identityKey.isEmpty { previousEndpoint = current }
        endpoint = link.endpoint
        setupToken = link.setupToken
        pairingInProgress = true
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
        setupToken = nil
        if pairingInProgress {
            pairingInProgress = false
            if restorePreviousEndpoint() {
                // The earlier pairing was never given up: it carries on.
                set(.connecting)
                startRunLoopIfNeeded()
                return
            }
            // Nothing working to go back to: the link's unproven endpoint must not stay in memory or on disk.
            endpoint = nil
            deps.endpointStore.clear()
        } else {
            endpoint = deps.endpointStore.load()
        }
        set(.unpaired)
    }

    /// Puts the working pairing back after a failed attempt. False when there was none.
    @discardableResult
    private func restorePreviousEndpoint() -> Bool {
        guard let previous = previousEndpoint else { return false }
        previousEndpoint = nil
        endpoint = previous
        try? deps.endpointStore.save(previous)  // a pending pin may have written the new one
        return true
    }

    /// The fingerprint of the Gateway an endpoint names: its pinned key's, else the link's.
    static func gatewayBinding(_ endpoint: GatewayEndpoint?) -> String? {
        guard let endpoint else { return nil }
        if !endpoint.identityKey.isEmpty { return PairingLink.fingerprint(ofKey: endpoint.identityKey) ?? endpoint.identityKey }
        return endpoint.linkFingerprint
    }

    /// Everything saved for the old pairing except the keys and the endpoint: outbox, last-seen state, the share
    /// inbox and recents, and the cache owner's files.
    private func wipeLocalData() async {
        await deps.outbox.wipe()
        if let dir = deps.stateDirectory {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("state.json"))
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(PhoneSettingsStore.fileName))
        }
        try? FileManager.default.removeItem(at: deps.libraryCache)
        deps.shareInbox?.wipe()
        resync = Resync(lastStateVersion: nil)
        await deps.onWipe()
    }

    /// Keys, endpoint, outbox, share inbox and cache are wiped; the UI returns to pairing. Everything is wiped
    /// even when one step fails; the first failure (a Keychain delete) is thrown at the end, after the state
    /// is `.revoked`, so the caller can say the key may still be on the phone.
    public func revoke() async throws {
        runLoop?.cancel()
        runLoop = nil
        let old = connection
        connection = nil
        await old?.close()
        var failure: (any Error)?
        do { try await deps.identityStore.wipe() } catch { failure = error }
        deps.endpointStore.clear()
        endpoint = nil
        previousEndpoint = nil
        pairingInProgress = false
        setupToken = nil
        await wipeLocalData()
        set(.revoked)
        if let failure { throw failure }
    }

    /// "Remove this phone": asks the Gateway to revoke this device (`devices.revokeSelf`), and only when
    /// it did, wipes everything (`revoke`). Throws `BackendError.unreachable` when there is no live connection, and
    /// the Gateway's refusal as `BackendError.refused`; in both cases nothing is wiped.
    public func revokeThisDevice() async throws {
        guard case .live = state, let connection, !ownDeviceID.isEmpty else { throw BackendError.unreachable }
        do {
            // The Gateway revokes the caller itself (read scope is enough) and closes this socket after the reply.
            _ = try await connection.call("devices.revokeSelf", params: .obj([:]))
        } catch {
            throw Self.backendError(error)
        }
        // The Gateway has removed this phone, so the wipe is not optional from here: a Keychain failure is shown
        // on the pairing screen instead of throwing back to a Settings sheet that is about to close.
        await revokeReportingFailure()
    }

    /// `revoke` for the paths with no caller to throw to: a Keychain failure goes to the pairing screen's message.
    private func revokeReportingFailure() async {
        do { try await revoke() } catch {
            for c in failureSubscribers.values {
                c.yield("This phone was removed, but its key could not be deleted from the Keychain. Restart your phone, then try again.")
            }
        }
    }

    /// The owner chose to start over from the refused or revoked screen.
    public func forgetGateway() async throws {
        defer { set(.unpaired) }
        try await revoke()
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
        // A write belongs to the Gateway this phone is paired with; without one there is nowhere to send it.
        guard let gateway = Self.gatewayBinding(endpoint) else { return .rejected("This phone isn't paired with a Mac.") }
        var stamped = entry
        stamped.gateway = gateway
        if await deps.outbox.enqueue(stamped) != nil {
            // The queue file could not be written. Sent now it is fine; waiting would not survive a relaunch.
            if case .live = state {} else {
                await deps.outbox.discard(id: entry.id)
                return .rejected("This phone couldn't save your message to send later. Try again when your Mac is reachable.")
            }
        }
        guard case .live = state else { return .queued }
        let outcomes = await flushOutbox()
        // A flush already running (the one that starts on connect) may have sent this entry, not ours.
        if let outcome = outcomes[entry.id] { return outcome }
        return await deps.outbox.takeOutcome(for: entry.id) ?? .queued
    }

    @discardableResult
    private func flushOutbox() async -> [String: Outbox.Delivery] {
        let gateway = Self.gatewayBinding(endpoint)
        return await deps.outbox.flush(gateway: gateway, checkGateway: true) { [self] entry in
            guard case .live = await self.currentState, let connection = await self.connection else {
                throw Outbox.OutboxSendError.retryLater
            }
            do {
                // The method comes from the entry's kind, never from what the queue file says.
                return try await connection.call(entry.kind.method, params: entry.params, idempotencyKey: entry.id)
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
            case .denied(let reason, let tokenInvalid, let code, let provenPinned):
                var wasPairing = token != nil
                if case .pending = state { wasPairing = true }
                let action = await handleDenied(
                    reason: reason, tokenInvalid: tokenInvalid, code: code, wasPairing: wasPairing, provenPinned: provenPinned)
                if action == .stop { return }
                try? await Task.sleep(for: .seconds(deps.backoff.delay(attempt: attempt)))
                attempt += 1
            case .refused:
                if pairingInProgress, restorePreviousEndpoint() {
                    pairingInProgress = false
                    setupToken = nil
                    publishFailure("That pairing link is for a different Mac than the one it names, so it was not used. Your earlier connection is unchanged.")
                    set(.connecting)
                    continue
                }
                set(.refused(.identityMismatch))
                return
            case .unreachable:
                if pairingInProgress, restorePreviousEndpoint() {
                    pairingInProgress = false
                    setupToken = nil
                    publishFailure("Couldn't reach the Mac in that pairing link. Your earlier connection is unchanged.")
                    set(.connecting)
                    continue
                }
                let reason = await UnreachableClassifier.classify(endpoint, reachability: deps.reachability)
                if Task.isCancelled { return }
                set(.unreachable(reason))
                try? await Task.sleep(for: .seconds(deps.backoff.delay(attempt: attempt)))
                attempt += 1
            }
        }
    }

    private func publishFailure(_ message: String) {
        for c in failureSubscribers.values { c.yield(message) }
    }

    private enum Attempt {
        case live(AsyncStream<WireEventFrame>)
        case pending(code: String)
        case denied(String, tokenInvalid: Bool, code: String?, provenPinned: Bool)
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
            case .paired(let deviceID, let scopes, let stateVersion):
                await pin(connection, to: endpoint, paired: true)
                self.connection = connection
                self.mapper = EventMapper(lookupQuestion: { [weak connection] id in
                    guard let connection,
                          let payload = try? await connection.call("questions.get", params: .obj(["inputRequestId": .string(id)]))
                    else { return nil }
                    return payload["inputRequest"].flatMap(ChatMapping.question(from:))
                })
                self.ownDeviceID = deviceID
                self.ownScopes = scopes
                set(.live)
                if resync.connected(stateVersion: stateVersion) { publish(.resynced) }
                persistStateVersion()
                Task { await self.flushOutbox() }
                return .live(connection.events)
            case .pending(let code):
                await pin(connection, to: endpoint, paired: false)  // the Gateway proved the key it is pinned by
                await connection.close()
                return .pending(code: code)
            case .denied(let reason, let tokenInvalid, let code):
                // Whether the Gateway that said no is the one this phone has pinned (a key, not just a link's
                // fingerprint) and proved it holds that key in this handshake.
                let proven = await connection.proven
                let provenPinned = !endpoint.identityKey.isEmpty && proven?.key == endpoint.identityKey
                await connection.close()
                return .denied(reason, tokenInvalid: tokenInvalid, code: code, provenPinned: provenPinned)
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
    ///
    /// While another pairing is still working (`previousEndpoint`), a `pending` proof stays in memory only and the
    /// stored endpoint is left alone; only `paired` replaces it, and only then, when the Gateway is a different
    /// one, is everything saved for the old Gateway wiped.
    private func pin(_ connection: GatewayConnection, to endpoint: GatewayEndpoint, paired: Bool) async {
        var pinned = endpoint
        if let proven = await connection.proven {
            pinned.identityKey = proven.key
            if pinned.lanCertSpki == nil { pinned.lanCertSpki = proven.certSPKI }
        }
        self.endpoint = pinned
        if paired {
            if let previous = previousEndpoint, Self.gatewayBinding(previous) != Self.gatewayBinding(pinned) {
                await wipeLocalData()
            }
            previousEndpoint = nil
            pairingInProgress = false
            try? deps.endpointStore.save(pinned)
        } else if previousEndpoint == nil {
            try? deps.endpointStore.save(pinned)
        }
    }

    private var ownDeviceID = ""
    private var ownScopes: [String] = []

    private func consume(_ events: AsyncStream<WireEventFrame>) async {
        for await frame in events {
            if resync.observed(seq: frame.seq, stateVersion: frame.stateVersion) { publish(.resynced) }
            guard var mapper else { continue }
            let (mapped, effect) = await mapper.map(frame, ownDeviceID: ownDeviceID)
            self.mapper = mapper
            for event in mapped { publish(event) }
            if effect == .thisDeviceRevoked {
                await revokeReportingFailure()
                return
            }
        }
        // The socket closed. Cached content stays readable; the loop reconnects.
        connection = nil
        persistStateVersion()
    }

    private enum DenialAction { case stop, retry }

    /// What a `denied` answer means, decided by the Gateway's machine-readable `code`, never by its wording:
    /// - `setup_token_invalid`: the link was spent; a message for the pairing screen, and a working pairing is
    ///   put back rather than cleared.
    /// - `device_revoked`, from the pinned Gateway that just proved its key, on a reconnect: this phone was
    ///   removed, so everything is wiped.
    /// - anything else on a reconnect (a reason that merely says "revoked", a code we do not know): nothing is
    ///   wiped; the phone keeps its pairing and tries again later.
    /// - anything else while pairing: a message, and the earlier pairing is put back.
    private func handleDenied(
        reason: String, tokenInvalid: Bool, code: String?, wasPairing: Bool, provenPinned: Bool
    ) async -> DenialAction {
        if !wasPairing {
            if code == "device_revoked", provenPinned {
                await revokeReportingFailure()
                return .stop
            }
            set(.unreachable(.gatewayOff))
            return .retry
        }
        let message = tokenInvalid
            ? "That pairing link expired or was already used. Make a new link on your Mac."
            : "Your Mac didn't accept this phone: \(reason)"
        publishFailure(message)
        pairingInProgress = false
        setupToken = nil
        if restorePreviousEndpoint() {
            set(.connecting)
            return .retry
        }
        deps.endpointStore.clear()
        endpoint = nil
        set(.unpaired)
        return .stop
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
        try? AppGroup.prepareDirectory(dir)
        try? JSONEncoder().encode(["stateVersion": version]).write(
            to: dir.appendingPathComponent("state.json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
