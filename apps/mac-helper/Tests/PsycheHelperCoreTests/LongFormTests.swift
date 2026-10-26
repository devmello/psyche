import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

/// `speech.transcribe_file` chunk planner and merger, and the `calendar.watch` window (#673).
@Suite("long-form transcription core")
struct LongFormTests {
    let min10 = LongFormLimits.chunkMs
    let overlap = LongFormLimits.overlapMs

    @Test func planTilesTheFile() {
        let threeHours = 3 * 60 * 60 * 1000
        let plan = LongFormChunkPlanner.plan(audioMs: threeHours)
        #expect(plan.count == 18)
        #expect(plan.first == LongFormChunk(index: 0, readFromMs: 0, readToMs: min10 + overlap, keepFromMs: 0, keepToMs: min10))
        #expect(plan.last == LongFormChunk(index: 17, readFromMs: 17 * min10 - overlap, readToMs: threeHours, keepFromMs: 17 * min10, keepToMs: threeHours))
        for (a, b) in zip(plan, plan.dropFirst()) {
            #expect(a.keepToMs == b.keepFromMs)
            #expect(a.readToMs - b.readFromMs == 2 * overlap)
        }
        #expect(plan.allSatisfy { $0.readToMs - $0.readFromMs <= min10 + 2 * overlap })
    }

    @Test func shortTailFoldsIntoThePreviousChunk() {
        // 21 minutes: 0–10, 10–21 (a 1-minute tail is not its own chunk).
        let plan = LongFormChunkPlanner.plan(audioMs: 21 * 60 * 1000)
        #expect(plan.map(\.keepToMs) == [min10, 21 * 60 * 1000])
        // 25 minutes: a 5-minute tail is.
        #expect(LongFormChunkPlanner.plan(audioMs: 25 * 60 * 1000).count == 3)
        // Shorter than a chunk, and empty.
        #expect(LongFormChunkPlanner.plan(audioMs: 40_000) == [LongFormChunk(index: 0, readFromMs: 0, readToMs: 40_000, keepFromMs: 0, keepToMs: 40_000)])
        #expect(LongFormChunkPlanner.plan(audioMs: 0).count == 1)
    }

    @Test func mergerKeepsEachPhraseOnce() {
        let plan = LongFormChunkPlanner.plan(audioMs: 2 * min10)
        var m = LongFormMerger()
        // Chunk 0 reads 0–10:10. It hears a phrase across the boundary (9:58–10:03) and a fragment
        // cut at its read end.
        m.add(plan[0], segments: [
            SpeechSegment(text: "first", startMs: 1000, endMs: 2000, final: true),
            SpeechSegment(text: "across the boundary", startMs: min10 - 2000, endMs: min10 + 3000, final: true),
            SpeechSegment(text: "cut", startMs: min10 + overlap - 500, endMs: min10 + overlap, final: true),
            SpeechSegment(text: "volatile", startMs: 3000, endMs: 4000, final: false),
        ], isLast: false)
        // Chunk 1 reads 9:50–20:00; its times are from 9:50.
        let base = plan[1].readFromMs
        m.add(plan[1], segments: [
            SpeechSegment(text: "tail of the previous", startMs: 1000, endMs: 3000, final: true),
            SpeechSegment(text: "across the boundary", startMs: min10 - 2100 - base, endMs: min10 + 3100 - base, final: true),
            SpeechSegment(text: "cut off here", startMs: min10 + overlap - 600 - base, endMs: min10 + overlap + 900 - base, final: true),
            SpeechSegment(text: "end", startMs: 2 * min10 - 1000 - base, endMs: 2 * min10 - base, final: true),
        ], isLast: true)
        #expect(m.segments.map(\.text) == ["first", "across the boundary", "cut off here", "end"])
        #expect(m.segments.map(\.startMs) == [1000, min10 - 2100, min10 + overlap - 600, 2 * min10 - 1000])
        #expect(m.text == "first across the boundary cut off here end")
        #expect(m.chunksAdded == 2)
    }

    @Test func samePhraseHeardTwiceKeepsTheLongerText() {
        let plan = LongFormChunkPlanner.plan(audioMs: 2 * min10)
        var m = LongFormMerger()
        // Midpoints land on both sides of the boundary, so both chunks keep a copy.
        m.add(plan[0], segments: [SpeechSegment(text: "we ship on", startMs: min10 - 3000, endMs: min10 + 2000, final: true)], isLast: false)
        let base = plan[1].readFromMs
        m.add(plan[1], segments: [SpeechSegment(text: "we ship on Friday", startMs: min10 - 2800 - base, endMs: min10 + 3600 - base, final: true)], isLast: true)
        #expect(m.segments.map(\.text) == ["we ship on Friday"])
    }

    @Test func resultAndProgressShapes() throws {
        var m = LongFormMerger()
        m.add(LongFormChunkPlanner.plan(audioMs: 5000)[0], segments: [SpeechSegment(text: "hi", startMs: 0, endMs: 500, final: true)], isLast: true)
        let r = try JSONDecoder().decode(SpeechTranscribeFileResult.self, from: JSONEncoder().encode(m.result(engine: .speechAnalyzer, language: "en-US", audioMs: 5000)))
        #expect(r.text == "hi" && r.chunks == 1 && r.audioMS == 5000 && r.engine == .speechAnalyzer)
        let p = try JSONDecoder().decode(SpeechProgressEvent.self, from: JSONEncoder().encode(SpeechEvent.progress(processedMs: 600_000, totalMs: 10_800_000, chunk: 1, chunks: 18)))
        #expect(p.fraction == 0.056 && p.chunk == 1 && p.chunks == 18 && p.processedMS == 600_000)
        guard case .object(let o) = SpeechEvent.progress(processedMs: 0, totalMs: 0, chunk: 0, chunks: 1) else { Issue.record("not an object"); return }
        #expect(o["fraction"] == .number(1))
    }

    @Test func paramsAndTheFourHourCeiling() throws {
        let r = try TranscribeFileParams(path: "/x/a.m4a", locale: "en-US", vocabulary: [" Psyche ", "Psyche"]).validated()
        #expect(r.maxDurationMs == LongFormLimits.maxDurationMs && r.vocabulary == ["Psyche"])
        #expect(r.engineRequest.volatile == false)
        try r.checkDuration(audioMs: 4 * 60 * 60 * 1000)
        do {
            try r.checkDuration(audioMs: 5 * 60 * 60 * 1000)
            Issue.record("5 h accepted")
        } catch let e as CapabilityError {
            #expect(e.reason == "too_long")
            #expect(e.message.contains("5 h 00 min") && e.message.contains("4 h 00 min"))
        }
        #expect(throws: CapabilityError.self) { try TranscribeFileParams(path: "/a", maxDurationMs: LongFormLimits.maxDurationMs + 1).validated() }
        #expect(throws: CapabilityError.self) { try TranscribeFileParams(path: "").validated() }
        #expect(throws: CapabilityError.self) { try TranscribeFileParams(path: "/a", locale: "not a locale").validated() }
    }

    // MARK: calendar.watch

    final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [JSONValue] = []
        func add(_ v: JSONValue) { lock.withLock { items.append(v) } }
        var all: [JSONValue] { lock.withLock { items } }
    }

    /// A window timer the test opens by hand, so no assertion depends on how fast a runner is.
    actor Gate {
        private var permits = 0
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func acquire() async {
            if permits > 0 { permits -= 1; return }
            await withCheckedContinuation { waiters.append($0) }
        }
        func release() {
            if waiters.isEmpty { permits += 1 } else { waiters.removeFirst().resume() }
        }
    }

    @Test func calendarChangesFoldIntoOneEventPerWindow() async throws {
        let (changes, feed) = AsyncStream.makeStream(of: Void.self)
        let (folded, foldedFeed) = AsyncStream.makeStream(of: Void.self)  // one element per counted change
        let (sent, sentFeed) = AsyncStream.makeStream(of: Void.self)  // one element per emitted event
        let events = Events()
        let gate = Gate()
        let at = Date(timeIntervalSince1970: 1_792_000_000)
        let run = _Concurrency.Task {
            await CalendarWatchCore.run(changes: changes, debounce: .seconds(30), now: { at },
                                        sleep: { _ in await gate.acquire() }, folded: { foldedFeed.yield() },
                                        emit: { events.add($0); sentFeed.yield() })
        }
        var foldedIterator = folded.makeAsyncIterator()
        var sentIterator = sent.makeAsyncIterator()
        // Five changes open one window; it closes only when the test says so.
        for _ in 0..<5 { feed.yield() }
        for _ in 0..<5 { await foldedIterator.next() }
        await gate.release()
        await sentIterator.next()
        // A change after it closed opens the next window.
        feed.yield()
        await foldedIterator.next()
        await gate.release()
        await sentIterator.next()
        feed.finish()
        #expect(await run.value == 2)
        let decoded = try events.all.map { try JSONDecoder().decode(AppleCalendarChangedEvent.self, from: JSONEncoder().encode($0)) }
        #expect(decoded.map(\.coalesced) == [5, 1])
        #expect(decoded.allSatisfy { $0.type == .calendarChanged && $0.at == AppleDates.string(at) })
    }

    @Test func cancellingTheWatchSendsNoLastEvent() async throws {
        let (changes, feed) = AsyncStream.makeStream(of: Void.self)
        let events = Events()
        let run = _Concurrency.Task { await CalendarWatchCore.run(changes: changes, debounce: .seconds(30), emit: { events.add($0) }) }
        feed.yield()
        try await _Concurrency.Task.sleep(for: .milliseconds(50))
        run.cancel()
        #expect(await run.value == 0)
        #expect(events.all.isEmpty)
    }
}
