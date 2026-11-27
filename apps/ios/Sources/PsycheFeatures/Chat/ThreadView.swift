import PsycheBlocks
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The reply the "Fork a plan…" sheet is open for.
private struct ForkTarget: Identifiable {
    let messageID: String
    var id: String { messageID }
}

/// What decides whether a row arrived or left: how many there are and which is last. Cheap to build and compare,
/// unlike an array of every id, which was allocated on every streamed delta.
private struct ItemsKey: Equatable {
    let count: Int
    let lastID: String?
    init(_ items: [ChatItem]) {
        count = items.count
        lastID = items.last?.id
    }
}

/// One thread row. Equal when what it draws is equal: the closures in `context` are rebuilt on every pass of
/// the thread view and are left out, so a delta on the streaming reply redraws only that reply's row.
private struct ThreadItemRow: View, Equatable {
    let item: ChatItem
    let gap: CGFloat
    let chosen: String?
    let delivery: MessageDelivery?
    let canAnswer: Bool
    let context: BlockContext

    nonisolated static func == (a: ThreadItemRow, b: ThreadItemRow) -> Bool {
        a.item == b.item && a.gap == b.gap && a.chosen == b.chosen && a.delivery == b.delivery
            && a.canAnswer == b.canAnswer
    }

    var body: some View {
        BlockView(item: item, context: context).padding(.top, gap)
    }
}

struct ThreadView: View {
    @State private var model: ThreadModel
    @State private var composer: ComposerModel
    @State private var position = ScrollPosition(edge: .bottom)
    /// Follow the stream while the reader is at the bottom; let go the moment they scroll up.
    @State private var pinned = true
    /// The latest geometry answer, kept whatever the scroll phase is, so the order of the two callbacks never matters.
    @State private var atBottom = true
    /// True between the reader's touch and the end of their drag (the reader's own scrolling, not content growth).
    @State private var reading = false
    @FocusState private var composerFocused: Bool
    /// The rename sheet's draft title, and whether it and the clear confirmation are showing.
    @State private var renameText = ""
    @State private var renaming = false
    @State private var confirmingClear = false
    @State private var confirmingFullAccess = false
    /// The reply a plan fork is being started from (the "Fork a plan…" sheet).
    @State private var forkingFrom: ForkTarget?
    @Environment(\.backend) private var backend
    @Environment(Router.self) private var router
    @Environment(Session.self) private var session
    @Environment(\.alerts) private var alerts
    private let motion = MotionContext()
    @Namespace private var glass
    @ScaledMetric(relativeTo: .body) private var jumpSize: CGFloat = 44
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
                        .padding(.bottom, 8)
                    }
                    ForEach(Array(thread.items.enumerated()), id: \.element.id) { index, item in
                        ThreadItemRow(
                            item: item, gap: index == 0 ? 0 : Self.gap(before: item, after: thread.items[index - 1]),
                            chosen: model.chosen[item.id], delivery: model.delivery[item.id],
                            canAnswer: session.state.canAnswer, context: context
                        )
                        // A streamed delta changes one row's `item`; every other row compares equal and keeps its
                        // body (and its parsed Markdown) instead of rebuilding about 60 times a second.
                        .equatable()
                            // A reply, card or tool line fades in with an 8 pt rise. The reader's own message
                            // does not move: sending is a frequent action and gets no motion (spec §3).
                            .transition(Self.isUser(item) ? .identity : motion.transition(.rise))
                            .contextMenu { replyMenu(for: item) }
                    }
                    feedbackRow(for: thread)
                    if model.compacting {
                        WorkingRow(text: String(localized: "Summarizing earlier messages", bundle: .module))
                            .padding(.top, 14)
                            .transition(motion.transition(.fade))
                    }
                    if thread.statusKind == .running, !isStreaming(thread) {
                        WorkingRow(text: model.displayStatus.isEmpty ? String(localized: "Working", bundle: .module) : model.displayStatus)
                            .padding(.top, 14)
                            .transition(motion.transition(.fade))
                    }
                }
                // The rows are scroll targets, so `position.scrollTo(id:)` can find the message the reader was on
                // after an older page is prepended.
                .scrollTargetLayout()
                // Only an item arriving or leaving animates. Streamed text grows inside its own item (the id
                // does not change), so tokens never trigger this: they are paced and faded by `StreamingText`.
                .psycheAnimation(.smooth, value: ItemsKey(thread.items))
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
        .onScrollPhaseChange { _, phase in
            // A drag decides the pin when it starts and when it ends, from the latest geometry answer. Animated
            // scrolls (Jump to latest) are the app's own and leave the pin alone.
            if phase == .interacting || phase == .decelerating || phase == .tracking {
                reading = true
                pinned = atBottom
            } else if phase == .idle, reading {
                reading = false
                pinned = atBottom
            }
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentSize.height - (geometry.contentOffset.y + geometry.containerSize.height) < 48
        } action: { _, nearBottom in
            atBottom = nearBottom
            pinned = ThreadScrollRules.pinned(pinned, reading: reading, nearBottom: nearBottom)
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y < ThreadScrollRules.olderThreshold
        } action: { _, nearTop in
            let hasOlder = model.phase.value?.olderCursor != nil
            if ThreadScrollRules.shouldLoadOlder(nearTop: nearTop, pinned: pinned, hasOlder: hasOlder, loading: model.loadingOlder) {
                loadOlderIfScrolledUp()
            }
        }
        .onChange(of: model.revision) { _, _ in
            if pinned { position.scrollTo(edge: .bottom) }
        }
        .overlay(alignment: .bottomTrailing) {
            if !pinned {
                GlassEffectContainer {
                    Button(action: jumpToLatest) {
                        Image(systemName: "arrow.down")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(PsycheColor.text)
                            .frame(width: jumpSize, height: jumpSize)
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
                        ThreadStatusLine(kind: thread.statusKind, text: model.displayStatus)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            // One menu, not an unexplained avatar beside it: Psyche's activity is its first item.
            ToolbarItem(placement: .primaryAction) { chatMenu }
        }
        #if os(iOS)
        // iPhone: a thread gets the whole height and the composer sits at the bottom, as in the mockup; back
        // returns to the tabs. iPad keeps its sidebar. Only while this page is the one on screen: after a back
        // swipe it can stay in the tree behind the list, and a hidden-bar preference would stay with it.
        .toolbarVisibility(sizeClass == .compact && frontmost ? .hidden : .automatic, for: .tabBar)
        #endif
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if model.isFullAccess { fullAccessBar }
                composerView
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: model.sentCount)
        .sheet(item: $forkingFrom) { target in
            PlanForkStartSheet(threadID: model.phase.value?.id ?? model.id, messageID: target.messageID, store: backend) { detail in
                router.showPlanFork(threadID: detail.fork.threadID, forkID: detail.fork.id)
            }
        }
        .alert(String(localized: "Couldn't do that", bundle: .module), isPresented: actionErrorShown) {
            Button(String(localized: "OK", bundle: .module)) { model.clearActionError() }
        } message: {
            Text(model.actionError ?? "")
        }
        .confirmationDialog(
            String(localized: "Turn on Full access?", bundle: .module), isPresented: $confirmingFullAccess,
            titleVisibility: .visible
        ) {
            Button(String(localized: "Turn on", bundle: .module)) { Task { await model.setFullAccess(true) } }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text(String(localized: "In this chat, Psyche will act without asking, except for sending to other people and payments, which still ask.", bundle: .module))
        }
        .alert(String(localized: "Rename chat", bundle: .module), isPresented: $renaming) {
            TextField(String(localized: "Title", bundle: .module), text: $renameText)
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
            Button(String(localized: "Save", bundle: .module)) {
                let title = renameText
                Task { await model.rename(to: title) }
            }
        }
        .confirmationDialog(
            String(localized: "Clear this chat?", bundle: .module), isPresented: $confirmingClear, titleVisibility: .visible
        ) {
            Button(String(localized: "Clear chat", bundle: .module), role: .destructive) {
                Task { await model.clear() }
            }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text(String(localized: "Its messages go, and Psyche starts fresh in this chat. The title and receipts stay.", bundle: .module))
        }
        // Files wait for a live connection: `.connecting` already counts as `canAnswer`, so key on the state itself.
        .onChange(of: session.state) { _, state in composer.connectionChanged(to: state) }
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
            #if DEBUG
            // `simctl launch … -psycheForkStart <messageID>` opens the "Fork a plan…" sheet (screenshots; no taps).
            if let messageID = UserDefaults.standard.string(forKey: "psycheForkStart"), !messageID.isEmpty {
                UserDefaults.standard.removeObject(forKey: "psycheForkStart")
                forkingFrom = ForkTarget(messageID: messageID)
            }
            #endif
            await model.observe()
        }
        .onDisappear { composer.dictation.stop() }
    }

    /// The persistent bar above the composer while the chat is in Full access, with a one-tap way back to Balanced.
    private var fullAccessBar: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(String(localized: "Full access: Psyche acts without asking, except sends and payments.", bundle: .module))
                .font(.footnote)
                .foregroundStyle(PsycheColor.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(String(localized: "Turn off", bundle: .module)) { Task { await model.setFullAccess(false) } }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(PsycheColor.inkText)
                .buttonStyle(.plain)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, PsycheMetrics.pagePadding)
        .padding(.vertical, 8)
        .background(PsycheColor.inkSoft)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .contain)
    }

    private var composerView: some View {
            Composer(
                composer: composer, isRunning: model.isRunning,
                // A file cannot join a reply that is running (the Gateway refuses it), so while one runs
                // the attachments wait for the reply to end.
                canSend: composer.canSend && session.state.canAnswer && !(model.isRunning && !composer.attachments.isEmpty),
                focused: $composerFocused, queue: model.queue, runMode: model.runMode, setRunMode: model.setRunMode,
                removeQueued: { item in Task { await model.removeQueued(item) } }, send: send, stop: model.cancel)
    }

    /// Chat-level actions: rename, fork from the latest reply, compact and clear. Fork needs a finished reply to
    /// fork from; compact and clear wait while Psyche runs (the Gateway refuses them then anyway).
    private var chatMenu: some View {
        Menu {
            Button {
                renameText = model.phase.value?.title ?? ""
                renaming = true
            } label: {
                Label(String(localized: "Rename", bundle: .module), systemImage: "pencil")
            }
            if let thread = model.phase.value, let messageID = latestReplyID(thread) {
                Button {
                    Task { if let newID = await model.fork(atMessage: messageID) { router.openThread(newID) } }
                } label: {
                    Label(String(localized: "Fork chat", bundle: .module), systemImage: "arrow.triangle.branch")
                }
            }
            if model.canToggleFullAccess {
                Toggle(isOn: Binding(
                    get: { model.isFullAccess },
                    set: { on in
                        // Turning it on shows the plain confirmation first; turning it off is one tap.
                        if on { confirmingFullAccess = true } else { Task { await model.setFullAccess(false) } }
                    })
                ) {
                    Label(String(localized: "Full access", bundle: .module), systemImage: "bolt.shield")
                }
            }
            Button { Task { await model.compact() } } label: {
                Label(String(localized: "Compact", bundle: .module), systemImage: "rectangle.compress.vertical")
            }
            .disabled(model.isRunning || model.compacting)
            Button(role: .destructive) { confirmingClear = true } label: {
                Label(String(localized: "Clear chat", bundle: .module), systemImage: "eraser")
            }
            .disabled(model.isRunning)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(String(localized: "Chat options", bundle: .module))
    }

    /// The reply's own menu: fork the chat from it, or give thumbs.
    @ViewBuilder private func replyMenu(for item: ChatItem) -> some View {
        if case .assistant(let messageID, _, false) = item {
            Button {
                Task { if let newID = await model.fork(atMessage: messageID) { router.openThread(newID) } }
            } label: {
                Label(String(localized: "Fork from here", bundle: .module), systemImage: "arrow.triangle.branch")
            }
            Button {
                forkingFrom = ForkTarget(messageID: messageID)
            } label: {
                Label(String(localized: "Fork a plan…", bundle: .module), systemImage: "arrow.triangle.branch")
            }
            .disabled(model.isRunning || !session.state.canAnswer)
            Button {
                Task { await model.giveFeedback(messageID: messageID, helpful: true) }
            } label: {
                Label(String(localized: "Good reply", bundle: .module), systemImage: "hand.thumbsup")
            }
            Button {
                Task { await model.giveFeedback(messageID: messageID, helpful: false) }
            } label: {
                Label(String(localized: "Not helpful", bundle: .module), systemImage: "hand.thumbsdown")
            }
        }
    }

    /// `plan_fork` and `plan_taken` blocks: the card that opens the Plans view, and the line after a plan is taken.
    private func planForkBlock(_ item: ChatItem) -> AnyView {
        switch item {
        case .planFork(_, let forkID): AnyView(PlanForkCard(forkID: forkID, store: backend))
        case .planTaken(_, let forkID, let branchID): AnyView(PlanTakenRow(forkID: forkID, branchID: branchID, store: backend))
        default: AnyView(EmptyView())
        }
    }

    /// A quiet thumbs row under the latest finished reply. The marked one is filled, in ink.
    @ViewBuilder private func feedbackRow(for thread: ChatThread) -> some View {
        if thread.statusKind != .running, !model.compacting, let messageID = latestReplyID(thread) {
            HStack(spacing: 8) {
                feedbackButton(messageID, helpful: true, symbol: "hand.thumbsup",
                               label: String(localized: "Good reply", bundle: .module))
                feedbackButton(messageID, helpful: false, symbol: "hand.thumbsdown",
                               label: String(localized: "Not helpful", bundle: .module))
            }
            .padding(.top, 6)
        }
    }

    private func feedbackButton(_ messageID: String, helpful: Bool, symbol: String, label: String) -> some View {
        let selected = model.feedback[messageID] == helpful
        return Button {
            Task { await model.giveFeedback(messageID: messageID, helpful: helpful) }
        } label: {
            Image(systemName: selected ? "\(symbol).fill" : symbol)
                .font(.subheadline)
                .foregroundStyle(selected ? PsycheColor.inkText : PsycheColor.muted)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The id of the newest reply, when it is finished (not streaming).
    private func latestReplyID(_ thread: ChatThread) -> String? {
        guard let last = thread.items.last, case .assistant(let messageID, _, false) = last else { return nil }
        return messageID
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
            retry: { model.retry($0) },
            planForkBlock: { item in planForkBlock(item) })
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

    /// Loads the older page only once the reader has scrolled away from the bottom. The top row also appears
    /// during the first layout, before the thread has been pinned to its newest message, so a load then would
    /// move the view off the bottom. While pinned at the bottom, a prepend does not move the view at all.
    private func loadOlderIfScrolledUp() {
        guard !pinned else { return }
        let anchor = model.phase.value?.items.first?.id
        Task {
            await model.loadOlder()
            // Keep the reader on the message they were looking at, unless they have since come back to the bottom.
            if let anchor, !pinned { position.scrollTo(id: anchor, anchor: .top) }
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

/// The thread's scroll rules as pure functions, so they can be tested without a view.
enum ThreadScrollRules {
    /// Distance from the top, in points, under which the next older page starts loading.
    static let olderThreshold: CGFloat = 300

    /// Whether the reader is following the bottom. A reader who is not scrolling keeps their pin, so content
    /// growing under them cannot unpin them; arriving at the bottom always pins.
    static func pinned(_ current: Bool, reading: Bool, nearBottom: Bool) -> Bool {
        if nearBottom { return true }
        return reading ? false : current
    }

    /// The older page loads only for a reader who has scrolled up to the top, and only once at a time.
    static func shouldLoadOlder(nearTop: Bool, pinned: Bool, hasOlder: Bool, loading: Bool) -> Bool {
        nearTop && !pinned && hasOlder && !loading
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
