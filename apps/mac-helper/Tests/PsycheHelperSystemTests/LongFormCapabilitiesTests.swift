import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

/// `speech.transcribe_file` on a fake engine and `calendar.watch` on a fake change source (#673).
/// Nothing here reads a real recording or the owner's calendar.
@Suite("long-form transcription and calendar.watch")
struct LongFormCapabilitiesTests {
    struct DenyAll: PermissionPreflight {
        func isGranted(_ permission: TCCPermission) -> Bool { false }
    }

    /// Fake engine: a 4-second phrase every 30 s of the file, starting at 28 s, so phrases straddle
    /// the 10-minute chunk boundaries. Each chunk reports the phrases it fully hears, in its own times.
    final class FakeEngine: LongFormAudioBackend, @unchecked Sendable {
        let durations: [String: Int]
        private let lock = NSLock()
        private var chunks: [LongFormChunk] = []
        init(_ durations: [String: Int]) { self.durations = durations }

        var seen: [LongFormChunk] { lock.withLock { chunks } }

        static func phrases(totalMs: Int) -> [(start: Int, end: Int)] {
            stride(from: 28_000, to: totalMs, by: 30_000).map { ($0, $0 + 4000) }.filter { $0.end <= totalMs }
        }

        func durationMs(path: String) throws -> Int {
            guard let d = durations[(path as NSString).lastPathComponent] else {
                throw CapabilityError(.invalidParams, reason: "unsupported_audio", "not audio")
            }
            return d
        }

        func transcribe(path: String, chunk: LongFormChunk, request: TranscribeRequest,
                        emit: @escaping @Sendable (JSONValue) async -> Void) async throws -> LongFormChunkResult {
            lock.withLock { chunks.append(chunk) }
            let total = try durationMs(path: path)
            let heard = Self.phrases(totalMs: total).filter { $0.start >= chunk.readFromMs && $0.end <= chunk.readToMs }
            return LongFormChunkResult(engine: request.vocabulary.isEmpty ? .speechAnalyzer : .dictationTranscriber, language: "en-US", segments: heard.map {
                SpeechSegment(text: "phrase at \($0.start / 1000) s", startMs: $0.start - chunk.readFromMs, endMs: $0.end - chunk.readFromMs, final: true)
            })
        }
    }

    final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [JSONValue] = []
        func add(_ v: JSONValue) { lock.withLock { items.append(v) } }
        var all: [JSONValue] { lock.withLock { items } }
    }

    let dir: URL
    let hour = 60 * 60 * 1000

    init() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("psyche-longform-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sub", isDirectory: true), withIntermediateDirectories: true)
        for name in ["meeting.m4a", "long.m4a", "notes.txt"] {
            FileManager.default.createFile(atPath: dir.appendingPathComponent(name).path, contents: Data("x".utf8))
        }
    }

    func handler(_ engine: FakeEngine) -> any CapabilityHandler {
        let roots = FinderRoots(roots: [dir.path])
        return SpeechCapabilities.make(preflight: DenyAll(), log: HelperLog(echo: { _ in }), fileBackend: engine, fileRoots: { roots })
            .first { $0.spec.name == "speech.transcribe_file" }!
    }

    func invoke(_ h: any CapabilityHandler, _ params: JSONValue, events: Events = Events()) async throws -> JSONValue {
        let ctx = InvocationContext(invocationId: "inv", capability: h.spec.name, params: params, approvalId: nil, emit: { events.add($0) })
        return try await h.invoke(ctx).result
    }

    func reason(_ h: any CapabilityHandler, _ params: JSONValue) async -> String? {
        do {
            _ = try await invoke(h, params)
            return nil
        } catch let e as CapabilityError {
            return e.reason
        } catch {
            return "other"
        }
    }

    func decode<T: Decodable>(_ type: T.Type, _ v: JSONValue) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(v))
    }

    @Test func threeHourRecordingOnTheFakeEngine() async throws {
        let total = 3 * hour
        let engine = FakeEngine(["meeting.m4a": total])
        let events = Events()
        let out = try await invoke(handler(engine), ["path": .string(dir.appendingPathComponent("meeting.m4a").path)], events: events)

        let result = try decode(SpeechTranscribeFileResult.self, out)
        let expected = FakeEngine.phrases(totalMs: total)
        #expect(result.chunks == 18 && engine.seen.count == 18)
        #expect(result.audioMS == total && result.engine == .speechAnalyzer && result.language == "en-US")
        #expect(result.segments.count == expected.count)
        #expect(result.segments.map(\.startMS) == expected.map(\.start))
        #expect(Set(result.segments.map(\.text)).count == expected.count)
        #expect(result.text.hasPrefix("phrase at 28 s phrase at 58 s"))
        #expect(out["provenance"] == "untrusted")
        // Every chunk reads at most 10 minutes plus the overlap on each side.
        #expect(engine.seen.allSatisfy { $0.readToMs - $0.readFromMs <= LongFormLimits.chunkMs + 2 * LongFormLimits.overlapMs })

        let progress = try events.all.map { try decode(SpeechProgressEvent.self, $0) }
        #expect(progress.count == 19)
        #expect(progress.map(\.chunk) == Array(0...18))
        #expect(progress.first?.processedMS == 0 && progress.last?.processedMS == total && progress.last?.fraction == 1)
        #expect(zip(progress, progress.dropFirst()).allSatisfy { $0.processedMS < $1.processedMS })
    }

    @Test func vocabularySelectsDictation() async throws {
        let engine = FakeEngine(["meeting.m4a": 90_000])
        let out = try await invoke(handler(engine), ["path": .string(dir.appendingPathComponent("meeting.m4a").path), "vocabulary": ["Psyche"]])
        #expect(try decode(SpeechTranscribeFileResult.self, out).engine == .dictationTranscriber)
        #expect(engine.seen.count == 1)
    }

    @Test func fiveHoursIsRefusedBeforeAnyAudio() async throws {
        let engine = FakeEngine(["long.m4a": 5 * hour, "meeting.m4a": 2 * hour])
        let h = handler(engine)
        do {
            _ = try await invoke(h, ["path": .string(dir.appendingPathComponent("long.m4a").path)])
            Issue.record("5 h accepted")
        } catch let e as CapabilityError {
            #expect(e.reason == "too_long" && e.code == .invalidParams)
            #expect(e.message.contains("up to 4 h 00 min"))
        }
        // A caller's lower ceiling applies too.
        #expect(await reason(h, ["path": .string(dir.appendingPathComponent("meeting.m4a").path), "maxDurationMs": .int(hour)]) == "too_long")
        #expect(engine.seen.isEmpty)
    }

    @Test func onlyFilesInsideTheRoots() async {
        let h = handler(FakeEngine(["meeting.m4a": 60_000]))
        #expect(await reason(h, ["path": "/etc/hosts"]) == "outside_granted_folders")
        #expect(await reason(h, ["path": .string(dir.appendingPathComponent("../meeting.m4a").path)]) == "outside_granted_folders")
        #expect(await reason(h, ["path": "relative.m4a"]) == "invalid_params")
        #expect(await reason(h, ["path": .string(dir.appendingPathComponent("sub").path)]) == "not_found")
        #expect(await reason(h, ["path": .string(dir.appendingPathComponent("missing.m4a").path)]) == "not_found")
        #expect(await reason(h, ["path": .string(dir.appendingPathComponent("notes.txt").path)]) == "unsupported_audio")
    }

    @Test func noGrantedFoldersMeansNothingIsReadable() async {
        let h = SpeechCapabilities.make(preflight: DenyAll(), fileBackend: FakeEngine([:]), fileRoots: { FinderRoots(roots: []) })
            .first { $0.spec.name == "speech.transcribe_file" }!
        #expect(await reason(h, ["path": "/Users/someone/a.m4a"]) == "no_granted_folders")
    }

    // MARK: calendar.watch

    struct FakeChanges: CalendarChangeSource {
        let stream: AsyncStream<Void>
        let granted: Bool
        func changes() throws -> AsyncStream<Void> {
            guard granted else { throw CapabilityError.permissionMissing(.calendars) }
            return stream
        }
    }

    @Test func calendarWatchStreamsDebouncedEvents() async throws {
        let (stream, feed) = AsyncStream.makeStream(of: Void.self)
        let h = CalendarWatchCapabilities.make(source: FakeChanges(stream: stream, granted: true), debounce: .milliseconds(100))[0]
        #expect(h.spec.name == "calendar.watch" && h.spec.streaming && h.spec.sideEffect == .read && h.spec.permissions == [.calendars])
        let events = Events()
        let run = _Concurrency.Task { try await invoke(h, [:], events: events) }
        for _ in 0..<3 { feed.yield() }
        try await _Concurrency.Task.sleep(for: .milliseconds(300))
        feed.finish()
        #expect(try await run.value["events"] == 1)
        let e = try events.all.map { try decode(AppleCalendarChangedEvent.self, $0) }
        #expect(e.map(\.coalesced) == [3])
    }

    @Test func calendarWatchNeedsAccess() async {
        let h = CalendarWatchCapabilities.make(source: FakeChanges(stream: AsyncStream { $0.finish() }, granted: false))[0]
        #expect(await reason(h, [:]) == "permission_missing")
    }
}
