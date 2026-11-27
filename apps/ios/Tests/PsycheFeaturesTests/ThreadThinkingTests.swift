import Foundation
import PsycheShared
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// The "Thinking" placeholder is a flag, not a string the code compares against, and what shows is localized.
/// Also the list's trailing debounce and the delta flush.
@MainActor
struct ThreadThinkingTests {
    @Test func aSendRaisesThePlaceholderWithoutPuttingEnglishInTheStatus() async throws {
        let model = ThreadModel(id: "thr_1", store: FixtureBackend())
        await model.load()
        model.send("Hello")
        #expect(model.thinking)
        #expect(model.phase.value?.status == "")
        #expect(model.phase.value?.statusKind == .running)
        #expect(model.displayStatus == String(localized: "Thinking", bundle: .module))
    }

    @Test func aGatewayStatusReplacesThePlaceholder() async throws {
        let model = ThreadModel(id: "thr_1", store: FixtureBackend())
        await model.load()
        model.send("Hello")
        model.apply(.status(threadID: "thr_1", status: "Reading your mail", kind: .running))
        #expect(!model.thinking)
        #expect(model.displayStatus == "Reading your mail")
    }

    @Test func aFinishedReplyEndsThePlaceholder() async throws {
        let model = ThreadModel(id: "thr_1", store: FixtureBackend())
        await model.load()
        model.send("Hello")
        model.apply(.item(threadID: "thr_1", item: .assistant(id: "a9", text: "Hi", streaming: false)))
        #expect(!model.thinking)
        #expect(model.phase.value?.statusKind == .neutral)
        #expect(model.displayStatus.isEmpty)
    }

    @Test func aGatewayStatusWorthThinkingIsJustText() async throws {
        let model = ThreadModel(id: "thr_1", store: FixtureBackend())
        await model.load()
        model.apply(.status(threadID: "thr_1", status: "Thinking", kind: .running))
        model.apply(.item(threadID: "thr_1", item: .assistant(id: "a9", text: "Hi", streaming: false)))
        // Only this phone's own placeholder ends with a reply; the Gateway's words stay until it says otherwise.
        #expect(model.phase.value?.status == "Thinking")
    }

    @Test func anAttachmentDetailIsLocalized() async throws {
        let model = ThreadModel(id: "thr_1", store: FixtureBackend())
        await model.load()
        model.send("", attachments: [AttachmentRef(id: "f1", name: "a.pdf", fileType: "pdf")])
        let detail = model.phase.value?.items.compactMap { item -> String? in
            if case .file(_, _, _, let detail, _, _, _) = item { detail } else { nil }
        }.first
        #expect(detail == String(localized: "Attached", bundle: .module))
    }

    @Test func streamedDeltasAreFoldedIntoTheStreamingReply() async throws {
        let model = ThreadModel(id: "thr_1", store: FixtureBackend())
        await model.load()
        model.apply(.item(threadID: "thr_1", item: .assistant(id: "a1", text: "", streaming: true)))
        model.apply(.delta(threadID: "thr_1", itemID: "a1", text: "Hel"))
        model.apply(.delta(threadID: "thr_1", itemID: "a1", text: "lo"))
        let folded = await LiveRefreshTests.eventually {
            if case .assistant(_, let text, true)? = model.phase.value?.items.last { text == "Hello" } else { false }
        }
        #expect(folded)
    }

    @Test func aBurstOfThreadEventsReloadsTheListOnceAfterItGoesQuiet() async throws {
        let store = FixtureBackend()
        let model = ThreadListModel(store: store)
        model.reloadDelay = .milliseconds(300)
        await model.load()
        let side = try #require(model.phase.value?.first { !$0.isMain })
        let task = Task { await model.observe() }
        defer { task.cancel() }
        try await Task.sleep(for: .milliseconds(80))
        try await store.renameThread(id: side.id, title: "Renamed on the Mac")
        for _ in 0..<4 {
            await store.publish(.changed(.threads))
            try await Task.sleep(for: .milliseconds(80))
        }
        // 80 ms after the last event: still inside the quiet period, so nothing was read yet.
        #expect(model.phase.value?.first { $0.id == side.id }?.title == side.title)
        let reloaded = await LiveRefreshTests.eventually {
            model.phase.value?.first { $0.id == side.id }?.title == "Renamed on the Mac"
        }
        #expect(reloaded)
    }

    @Test func aThreadEventDoesNotReloadAnArchiveThatIsNotShowing() async throws {
        let store = FixtureBackend()
        let model = ThreadListModel(store: store)
        model.reloadDelay = .milliseconds(30)
        await model.load()
        #expect(model.archived.isEmpty)
        let side = try #require(model.phase.value?.first { !$0.isMain })
        let task = Task { await model.observe() }
        defer { task.cancel() }
        try await Task.sleep(for: .milliseconds(80))
        try await store.archiveThread(id: side.id)
        await store.publish(.changed(.threads))
        let moved = await LiveRefreshTests.eventually { model.phase.value?.contains { $0.id == side.id } == false }
        #expect(moved)
        // The list moved on; the hidden archive was left alone until it is opened or refreshed.
        #expect(model.archived.isEmpty)
        await model.load()
        #expect(model.archived.contains { $0.id == side.id })
    }
}
