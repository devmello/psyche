import PsycheBlocks
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

struct ThreadView: View {
    @State private var model: ThreadModel
    @State private var composer: ComposerModel
    @State private var position = ScrollPosition(edge: .bottom)
    /// Follow the stream while the reader is at the bottom; let go the moment they scroll up.
    @State private var pinned = true
    @State private var scrolling = false
    @FocusState private var composerFocused: Bool
    @Environment(Router.self) private var router
    @Environment(Session.self) private var session
    @Environment(\.alerts) private var alerts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(id: String, store: any PsycheBackend) {
        _model = State(initialValue: ThreadModel(id: id, store: store))
        _composer = State(initialValue: ComposerModel(threadID: id, store: store))
    }

    var body: some View {
        ScrollView {
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { thread in
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(thread.items.enumerated()), id: \.element.id) { index, item in
                        BlockView(item: item, context: context)
                            .padding(.top, index == 0 ? 0 : Self.gap(before: item, after: thread.items[index - 1]))
                    }
                    if thread.statusKind == .running, !isStreaming(thread) {
                        WorkingRow(text: thread.status.isEmpty ? "Working" : thread.status)
                            .padding(.top, 14)
                    }
                }
                .padding(.horizontal, PsycheMetrics.pagePadding)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .onScrollPhaseChange { _, phase in scrolling = phase != .idle }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentSize.height - (geometry.contentOffset.y + geometry.containerSize.height) < 48
        } action: { _, nearBottom in
            // Only the reader's own scrolling can change this; content growing under us must not unpin.
            if scrolling { pinned = nearBottom }
        }
        .onChange(of: model.revision) { _, _ in
            if pinned { position.scrollTo(edge: .bottom) }
        }
        .overlay(alignment: .bottomTrailing) {
            if !pinned {
                Button(action: jumpToLatest) {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PsycheColor.text)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .padding(.trailing, 16).padding(.bottom, 10)
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
                .accessibilityLabel("Jump to latest")
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: pinned)
        .psycheScreen()
        .navigationTitle(model.phase.value?.title ?? "")
        .psycheInlineTitle()
        .toolbar {
            // The title with its status as dot + words ("● Running · step 3 of 7"), as in the Chat mockup.
            ToolbarItem(placement: .principal) {
                if let thread = model.phase.value {
                    VStack(spacing: 1) {
                        Text(thread.title).font(.headline).foregroundStyle(PsycheColor.text).lineLimit(1)
                        if !thread.status.isEmpty {
                            StatusDot(thread.statusKind.dot, thread.status, textColor: PsycheColor.muted, font: .caption)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            ToolbarItem(placement: .primaryAction) { AgentButton(needsYou: false) }
        }
        #if os(iOS)
        // iPhone: a thread gets the whole height and the composer sits at the bottom, as in the mockup; back
        // returns to the tabs. iPad keeps its sidebar.
        .toolbarVisibility(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
        #endif
        .safeAreaInset(edge: .bottom) {
            Composer(
                composer: composer, isRunning: model.isRunning, canSend: composer.canSend && session.state.canAnswer,
                focused: $composerFocused, send: send, stop: model.cancel)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: model.sentCount)
        .onChange(of: session.state.canAnswer) { _, reachable in if reachable { composer.retryWaiting() } }
        .task {
            await model.load()
            if let pending = router.pendingDraft {
                composer.text = pending
                router.pendingDraft = nil
                composerFocused = true
            }
            #if DEBUG
            // `simctl launch … -psycheSend "text"` sends a message on open (screenshots, demos).
            if let text = UserDefaults.standard.string(forKey: "psycheSend"), !text.isEmpty {
                UserDefaults.standard.removeObject(forKey: "psycheSend")
                Task {
                    // On a cold launch the first load can run before the Gateway is live; wait for the thread.
                    for _ in 0..<40 where model.phase.value == nil { try? await Task.sleep(for: .milliseconds(500)) }
                    model.send(text)
                }
            }
            #endif
            await model.observe()
        }
        .onDisappear { composer.dictation.stop() }
    }

    private var context: BlockContext {
        BlockContext(
            chosen: model.chosen,
            canAnswer: session.state.canAnswer,
            delivery: model.delivery,
            choose: { question, option in model.choose(option: option, for: question) },
            openApproval: { router.sheet = .approval($0) },
            openRoute: { router.open(appPath: $0) },
            openThread: { router.openThread($0) },
            openFile: { router.open(appPath: "/library/\($0)") },
            retry: { model.retry($0) })
    }

    private func send() {
        let message = composer.takeMessage()
        alerts?.noteSentFromPhone()
        pinned = true
        model.send(message.text, attachments: message.attachments)
    }

    private func jumpToLatest() {
        pinned = true
        withAnimation(reduceMotion ? nil : .snappy) { position.scrollTo(edge: .bottom) }
    }

    private func isStreaming(_ thread: ChatThread) -> Bool {
        if case .assistant(_, _, true)? = thread.items.last { return true }
        return false
    }

    /// Tool calls and their evidence sit close together; everything else breathes.
    private static func gap(before item: ChatItem, after previous: ChatItem) -> CGFloat {
        func isTool(_ item: ChatItem) -> Bool {
            switch item {
            case .toolCall, .toolRun: true
            default: false
            }
        }
        switch (previous, item) {
        case _ where isTool(previous) && isTool(item): return 2
        case (_, .evidence): return 6
        case (.user, .file), (.file, .file): return 8
        default: return 14
        }
    }
}

private struct WorkingRow: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(.subheadline).foregroundStyle(PsycheColor.muted)
        }
        .accessibilityElement(children: .combine)
    }
}
