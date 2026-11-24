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
    private let motion = MotionContext()
    @Namespace private var glass
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.threadIsFrontmost) private var frontmost

    init(id: String, store: any PsycheBackend) {
        _model = State(initialValue: ThreadModel(id: id, store: store))
        _composer = State(initialValue: ComposerModel(threadID: id, store: store))
    }

    var body: some View {
        ScrollView {
            PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { thread in
                LazyVStack(alignment: .leading, spacing: 0) {
                    // The sentinel is the top row while older messages exist. Its id is the cursor, so each page
                    // makes a new row and it loads once when it scrolls into view; nothing shows when there is none.
                    if let cursor = thread.olderCursor {
                        PageSentinel(
                            loading: model.loadingOlder,
                            label: String(localized: "Loading older messages", bundle: .module)
                        )
                        .id(cursor)
                        .onAppear { loadOlder() }
                        .padding(.bottom, 8)
                    }
                    ForEach(Array(thread.items.enumerated()), id: \.element.id) { index, item in
                        BlockView(item: item, context: context)
                            .padding(.top, index == 0 ? 0 : Self.gap(before: item, after: thread.items[index - 1]))
                            // A reply, card or tool line fades in with an 8 pt rise. The reader's own message
                            // does not move: sending is a frequent action and gets no motion (spec §3).
                            .transition(Self.isUser(item) ? .identity : motion.transition(.rise))
                    }
                    if thread.statusKind == .running, !isStreaming(thread) {
                        WorkingRow(text: thread.status.isEmpty ? String(localized: "Working", bundle: .module) : thread.status)
                            .padding(.top, 14)
                            .transition(motion.transition(.fade))
                    }
                }
                // Only an item arriving or leaving animates. Streamed text grows inside its own item (the id
                // does not change), so tokens never trigger this: they are paced and faded by `StreamingText`.
                .psycheAnimation(.smooth, value: thread.items.map(\.id))
                .padding(.horizontal, PsycheMetrics.pagePadding)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        // Content that grows under a reader who is at the bottom (a streaming reply) stays anchored there in
        // the same layout pass, instead of being chased by a scroll after the fact.
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
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
                GlassEffectContainer {
                    Button(action: jumpToLatest) {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(PsycheColor.text)
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .glassEffectID("jump-to-latest", in: glass)
                }
                .padding(.trailing, 16).padding(.bottom, 10)
                .transition(motion.transition(.control))
                .accessibilityLabel(String(localized: "Jump to latest", bundle: .module))
            }
        }
        .psycheAnimation(.snappy, value: pinned)
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
        // returns to the tabs. iPad keeps its sidebar. Only while this page is the one on screen: after a back
        // swipe it can stay in the tree behind the list, and a hidden-bar preference would stay with it.
        .toolbarVisibility(sizeClass == .compact && frontmost ? .hidden : .automatic, for: .tabBar)
        #endif
        .safeAreaInset(edge: .bottom) {
            Composer(
                composer: composer, isRunning: model.isRunning,
                // A file cannot join a reply that is running (the Gateway refuses it), so while one runs
                // the attachments wait for the reply to end.
                canSend: composer.canSend && session.state.canAnswer && !(model.isRunning && !composer.attachments.isEmpty),
                focused: $composerFocused, queue: model.queue, runMode: model.runMode, setRunMode: model.setRunMode,
                removeQueued: { item in Task { await model.removeQueued(item) } }, send: send, stop: model.cancel)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: model.sentCount)
        .alert(String(localized: "Couldn't do that", bundle: .module), isPresented: actionErrorShown) {
            Button(String(localized: "OK", bundle: .module)) { model.clearActionError() }
        } message: {
            Text(model.actionError ?? "")
        }
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

    private var actionErrorShown: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.clearActionError() } })
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
        if model.isRunning {
            sendWhileRunning()
            return
        }
        let message = composer.takeMessage()
        alerts?.noteSentFromPhone()
        pinned = true
        model.send(message.text, attachments: message.attachments)
    }

    /// Steers the running reply or queues the text, by the chosen mode. The text leaves the field only once the
    /// Gateway has taken it, so a refusal keeps it for another try.
    private func sendWhileRunning() {
        let text = composer.trimmedText
        alerts?.noteSentFromPhone()
        pinned = true
        Task {
            if await model.submitWhileRunning(text) { composer.textWasSent(text) }
        }
    }

    /// Loads the older page and keeps the reader on the message they were looking at: the first message that was
    /// on screen stays where it was once the page is in front of it.
    private func loadOlder() {
        let anchor = model.phase.value?.items.first?.id
        Task {
            await model.loadOlder()
            if let anchor { position.scrollTo(id: anchor, anchor: .top) }
        }
    }

    private func jumpToLatest() {
        pinned = true
        // A smooth scroll of at most 300 ms; instant under Reduce Motion.
        withAnimation(motion.layout(.smooth)) { position.scrollTo(edge: .bottom) }
    }

    private static func isUser(_ item: ChatItem) -> Bool {
        if case .user = item { return true }
        return false
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

/// A quiet spinner while a page loads; otherwise a 1 pt clear row that marks where the next page starts.
struct PageSentinel: View {
    let loading: Bool
    let label: String

    var body: some View {
        Group {
            if loading {
                ProgressView().controlSize(.small).accessibilityLabel(label)
            } else {
                Color.clear.frame(height: 1)
            }
        }
        .frame(maxWidth: .infinity)
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
