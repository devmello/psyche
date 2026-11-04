import Foundation
import PsycheShared
import PsycheStore
import Testing

@testable import PsycheClient

/// The phone against a real Gateway: `tests/integration/ios-gateway/serve.ts` starts the repo's composed
/// `psyched` (temporary `$PSYCHE_HOME`, scripted model) on loopback. Pair, refuse an identity mismatch,
/// send a message and receive its streamed reply.
///
/// Skipped when there is no Gateway to start (no `node`, or `pnpm install` was not run), or when
/// `PSYCHE_IOS_SKIP_LIVE=1`.
@Suite(.serialized, .enabled(if: LiveGateway.available, "needs node and an installed workspace (pnpm install)"))
struct LiveGatewayTests {
    @Test func pairsRefusesAMismatchAndStreamsAReply() async throws {
        let gateway = try await LiveGateway.start()
        defer { gateway.stop() }
        let info = gateway.info

        // Main's pairing links name an https origin that is never loopback, so the test builds the link from its
        // parts: the real fingerprint and a real setup token minted by the Gateway, dialing the loopback origin.
        func link(fingerprint: String? = nil, token: String) -> PairingLink {
            PairingLink(
                gatewayURL: info.origin, gatewayFingerprint: fingerprint ?? info.fingerprint, setupToken: token,
                hostName: "ios-test-host")
        }

        // 1. The link names a different Gateway: the real Gateway's key does not hash to it, so the phone stops
        //    before signing anything, presents no token, and stores nothing.
        do {
            let h = LiveHarness()
            let wrong = link(fingerprint: "sha256:" + String(repeating: "0", count: 64), token: info.spareSetupToken)
            await h.client.beginPairing(wrong)
            let state = await GatewayClientTests.wait(h.client, for: { $0 == .refused(.identityMismatch) }, seconds: 15)
            #expect(state == .refused(.identityMismatch))
            #expect(h.endpointStore.load() == nil)
        }
        gateway.send("tokens")
        #expect(await gateway.nextLine(timeout: 10)?.contains("\"tokens\":[\"live\",\"live\"]") == true)

        // 2. The right link: the key the Gateway proves hashes to the link's fingerprint, the token is presented
        //    only after that, and the device is paired at once with the scopes chosen when the token was made.
        //    Today's Gateway takes a setup token from a new device only when it is the desktop app (auth.ts: "the
        //    phone comes later"), so the owner pairs this phone first, as approving it on the Mac does; the link
        //    then arrives from a device the Gateway already knows, which it accepts and spends.
        let h = LiveHarness()
        let me = try await h.identityStore.identity()
        gateway.send("enroll \(me.deviceId) \(me.publicKey)")
        #expect(await gateway.nextLine(timeout: 10)?.contains("\"enrolled\":true") == true)
        await h.client.beginPairing(link(token: info.setupToken))
        let live = await GatewayClientTests.wait(h.client, for: { $0 == .live }, seconds: 20)
        #expect(live == .live)
        // The pin is now the key itself, learned from the proof and not from the link.
        #expect(h.endpointStore.load()?.identityKey == info.identityKey)
        #expect(h.endpointStore.load()?.linkFingerprint == info.fingerprint)
        // The token was presented, and only after the proof: one is spent, the one the refused phone held is not.
        gateway.send("tokens")
        let statuses = await gateway.nextLine(timeout: 10) ?? ""
        #expect(statuses.contains("\"used\"") && statuses.contains("\"live\""))

        // 3. Send a message and receive the streamed reply.
        let backend = GatewayBackend(client: h.client)
        let events = backend.events()
        let thread = try await backend.newThread()
        let sent = try await backend.send(MessageDraft(threadID: thread.id, text: "Say hello"))
        #expect(sent.delivery == .sent)

        let streamed = await withTaskGroup(of: String?.self) { group in
            group.addTask {
                var text = ""
                for await event in events {
                    guard case .chat(let chat) = event, chat.threadID == thread.id else { continue }
                    switch chat {
                    case .item(_, .assistant(_, let t, _)): text = t
                    case .delta(_, _, let t): text += t
                    case .done: return text
                    default: break
                    }
                }
                return nil
            }
            group.addTask { try? await Task.sleep(for: .seconds(30)); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        #expect(streamed == info.reply)

        // The committed transcript has the same reply, oldest first.
        let full = try await backend.thread(id: thread.id)
        #expect(full.items.contains(.user(id: full.items.compactMap { if case .user(let id, _) = $0 { id } else { nil } }.first ?? "", text: "Say hello")))
        #expect(full.items.contains { if case .assistant(_, let t, false) = $0 { t == info.reply } else { false } })

        // 3b. Memory and Search answer over the real protocol (an empty graph is an empty snapshot, not an error).
        let memory = try await backend.memory()
        #expect(memory.todos.isEmpty && memory.people.isEmpty)
        let found = try await backend.search(query: "hello")
        #expect(found.answer == nil)
        #expect(try await backend.pinnedWidgets().isEmpty)

        // 4. A gap in today's Gateway, kept here so the test says so when it closes: a phone the owner has not
        //    paired is denied its setup token (desktop only, auth.ts), and the denial reads like an expired link.
        //    When the Gateway takes setup tokens from `ios`, this phone pairs and this expectation flips.
        do {
            let fresh = LiveHarness()
            let failures = fresh.client.pairingFailures()
            await fresh.client.beginPairing(link(token: info.spareSetupToken))
            let message = await withTaskGroup(of: String?.self) { group in
                group.addTask { for await m in failures { return m }; return nil }
                group.addTask { try? await Task.sleep(for: .seconds(15)); return nil }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }
            #expect(message?.contains("Make a new link on your Mac") == true)
            #expect(fresh.endpointStore.load() == nil)
        }

        // Resilience: the Gateway closing the socket brings the phone back without losing the session.
        let threads = try await backend.threads()
        #expect(threads.contains { $0.id == thread.id })
    }
}

struct LiveHarness {
    let client: GatewayClient
    let endpointStore: EndpointStore
    let identityStore = DeviceIdentityStore(store: MemorySecretStore())
    init() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("live-\(UUID().uuidString)")
        endpointStore = EndpointStore(directory: dir)
        client = GatewayClient(dependencies: GatewayClientDependencies(
            endpointStore: endpointStore, identityStore: identityStore,
            outbox: Outbox(directory: dir), reachability: FakeReachability(resolvesHost: true, local: true),
            deviceName: "Test iPhone", stateDirectory: dir, pendingRecheck: .milliseconds(300)))
    }
}

/// The Node process running `serve.ts`.
final class LiveGateway: @unchecked Sendable {
    struct Info: Decodable {
        var origin: String
        var identityKey: String
        /// `sha256:<hex>` of the identity key, as a link carries it.
        var fingerprint: String
        /// Real one-time setup tokens (operator.read, write, approvals) minted in the Gateway's database.
        var setupToken: String
        var spareSetupToken: String
        var reply: String
    }

    static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()  // file, PsycheClientTests, Tests, ios, apps -> repo root

    static var available: Bool {
        if ProcessInfo.processInfo.environment["PSYCHE_IOS_SKIP_LIVE"] == "1" { return false }
        let modules = repoRoot.appendingPathComponent("tests/integration/node_modules/@psyche").path
        return FileManager.default.fileExists(atPath: modules) && nodePath() != nil
    }

    static func nodePath() -> String? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let candidates = path.split(separator: ":").map { "\($0)/node" } + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private let process: Process
    private let stdin: Pipe
    private let queue: LineQueue
    let info: Info

    private init(info: Info, process: Process, stdin: Pipe, queue: LineQueue) {
        self.info = info
        self.process = process
        self.stdin = stdin
        self.queue = queue
    }

    static func start() async throws -> LiveGateway {
        let process = Process()
        let input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: nodePath()!)
        process.arguments = ["ios-gateway/serve.ts"]
        process.currentDirectoryURL = repoRoot.appendingPathComponent("tests/integration")
        process.standardInput = input
        process.standardOutput = output
        // PSYCHE_IOS_LIVE_LOG=<file> keeps the Gateway process's stderr for debugging.
        if let log = ProcessInfo.processInfo.environment["PSYCHE_IOS_LIVE_LOG"] {
            FileManager.default.createFile(atPath: log, contents: nil)
            process.standardError = FileHandle(forWritingAtPath: log)
        } else {
            process.standardError = FileHandle.nullDevice
        }
        let queue = LineQueue()
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { queue.feed(chunk) }
        }
        try process.run()
        guard let first = await queue.next(timeout: 60), let info = try? JSONDecoder().decode(Info.self, from: Data(first.utf8)) else {
            process.terminate()
            throw LiveGatewayError.didNotStart
        }
        return LiveGateway(info: info, process: process, stdin: input, queue: queue)
    }

    func send(_ command: String) { try? stdin.fileHandleForWriting.write(contentsOf: Data((command + "\n").utf8)) }

    func nextLine(timeout: Double) async -> String? { await queue.next(timeout: timeout) }

    func stop() {
        send("stop")
        try? stdin.fileHandleForWriting.close()
        let process = process
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { if process.isRunning { process.terminate() } }
    }
}

enum LiveGatewayError: Error { case didNotStart }

/// Lines read from the Gateway process, handed out in order.
final class LineQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var partial = Data()
    private var lines: [String] = []

    func feed(_ chunk: Data) {
        lock.withLock {
            partial.append(chunk)
            while let newline = partial.firstIndex(of: 0x0A) {
                lines.append(String(decoding: partial[partial.startIndex..<newline], as: UTF8.self))
                partial.removeSubrange(partial.startIndex...newline)
            }
        }
    }

    func next(timeout: Double) async -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let line = lock.withLock({ lines.isEmpty ? nil : lines.removeFirst() }) { return line }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return nil
    }
}
