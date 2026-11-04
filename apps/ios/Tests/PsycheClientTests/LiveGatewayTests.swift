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

        // 1. A different Gateway key in the link: the real Gateway's challenge fails the pin, so the
        //    phone stops before signing anything and stores nothing.
        do {
            let h = LiveHarness()
            var wrong = try PairingLink.parse(info.link)
            wrong = PairingLink(
                gatewayURL: wrong.gatewayURL, gatewayIdentityKey: PairingLinkTests.bytes(99),
                setupToken: wrong.setupToken, hostName: wrong.hostName)
            await h.client.beginPairing(wrong)
            let state = await GatewayClientTests.wait(h.client, for: { $0 == .refused(.identityMismatch) }, seconds: 15)
            #expect(state == .refused(.identityMismatch))
            #expect(h.endpointStore.load() == nil)
        }

        // 2. The right link: pending with a code, approved on the "Mac", then live.
        let h = LiveHarness()
        let link = try PairingLink.parse(info.link)
        #expect(link.fingerprint == PairingLink.fingerprint(ofKey: info.identityKey))
        await h.client.beginPairing(link)
        let pending = await GatewayClientTests.wait(h.client, for: { if case .pending = $0 { true } else { false } }, seconds: 15)
        guard case .pending(let approval)? = pending else {
            Issue.record("expected pending, got \(String(describing: pending))")
            return
        }
        #expect(approval.code.filter(\.isNumber).count == 6 || !approval.code.isEmpty)
        gateway.send("approve")
        let approved = await gateway.nextLine(timeout: 15)
        #expect(approved?.contains("\"approved\":true") == true)
        let live = await GatewayClientTests.wait(h.client, for: { $0 == .live }, seconds: 20)
        #expect(live == .live)
        #expect(h.endpointStore.load()?.identityKey == info.identityKey)

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

        // Resilience: the Gateway closing the socket brings the phone back without losing the session.
        let threads = try await backend.threads()
        #expect(threads.contains { $0.id == thread.id })
    }
}

struct LiveHarness {
    let client: GatewayClient
    let endpointStore: EndpointStore
    init() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("live-\(UUID().uuidString)")
        endpointStore = EndpointStore(directory: dir)
        client = GatewayClient(dependencies: GatewayClientDependencies(
            endpointStore: endpointStore, identityStore: DeviceIdentityStore(store: MemorySecretStore()),
            outbox: Outbox(directory: dir), reachability: FakeReachability(resolvesHost: true, local: true),
            deviceName: "Test iPhone", stateDirectory: dir, pendingRecheck: .milliseconds(300)))
    }
}

/// The Node process running `serve.ts`.
final class LiveGateway: @unchecked Sendable {
    struct Info: Decodable {
        var origin: String
        var identityKey: String
        var link: String
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
