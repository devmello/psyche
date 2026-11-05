import PsycheBlocks
import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

struct HomeView: View {
    @State private var model: HomeModel
    @State private var ask = ""
    @Environment(Session.self) private var session
    @Environment(Router.self) private var router
    @Environment(\.alerts) private var alerts

    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        _model = State(initialValue: HomeModel(store: store))
    }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                PageHeader("Home", eyebrow: Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day())) {
                    AgentButton(needsYou: !(model.phase.value?.needsYou.isEmpty ?? true), glass: true)
                }
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                askField
                PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { snapshot in
                    sections(snapshot)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .psycheHidesNavigationBar()
        .overlay(alignment: .bottom) { notice }
        .animation(.default, value: model.notice)
        .task {
            await model.load()
            await model.observe()
        }
        .refreshable { await model.load() }
        #if DEBUG
        // Screenshots without a swipe: `-psycheHomeScroll pinned` brings the Pinned section into view.
        .onChange(of: model.pinnedWidgets.count) { _, count in
            guard count > 0, UserDefaults.standard.string(forKey: "psycheHomeScroll") == "pinned" else { return }
            Task { try? await Task.sleep(for: .milliseconds(400)); withAnimation { proxy.scrollTo("pinned", anchor: .top) } }
        }
        #endif
        }
    }

    // MARK: Ask Psyche

    private var askField: some View {
        HStack(spacing: 10) {
            TextField("Ask Psyche anything", text: $ask)
                .font(.callout)
                .submitLabel(.send)
                .onSubmit(submitAsk)
            if !ask.isEmpty {
                Button(action: submitAsk) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(PsycheColor.inkText)
                }
                .accessibilityLabel("Ask")
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
        .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PsycheMetrics.cardRadius, style: .continuous)
                .strokeBorder(PsycheColor.rule, lineWidth: 1))
    }

    private func submitAsk() {
        let text = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        ask = ""
        router.askPsyche(text)
    }

    // MARK: Sections (empty ones aren't drawn)

    @ViewBuilder
    private func sections(_ snapshot: HomeSnapshot) -> some View {
        if !snapshot.needsYou.isEmpty { needsYou(snapshot.needsYou) }
        if !snapshot.running.isEmpty { running(snapshot.running) }
        if !snapshot.today.isEmpty { today(snapshot.today) }
        if !model.comingUp.isEmpty { todos("Coming up", model.comingUp) }
        if !model.laterTodos.isEmpty { todos("To-do", model.laterTodos) }
        if !snapshot.keepInTouch.isEmpty { keepInTouch(snapshot.keepInTouch) }
        if !model.pinnedWidgets.isEmpty { pinned(model.pinnedWidgets) }
        more
    }

    private func needsYou(_ items: [NeedsYouItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Needs you", count: items.count, needsYou: true)
            PaperCard {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider() }
                    needsYouRow(item)
                }
            }
        }
    }

    @ViewBuilder
    private func needsYouRow(_ item: NeedsYouItem) -> some View {
        let canAnswer = session.state.canAnswer
        let kind = item.kind.label
        let evidence = canAnswer ? [kind, item.source, item.time] : [kind, "reconnect to answer"]
        let row = NeedsYouRow(title: item.title, evidence: evidence, showsChevron: canAnswer)
        if canAnswer {
            Button { router.open(item) } label: { row }.buttonStyle(.plain)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private func running(_ tasks: [RunningTask]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Running")
            ForEach(tasks) { task in
                PaperCard(padding: 14) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(task.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                            Spacer(minLength: 0)
                            if alerts?.watching.contains(task.id) == true {
                                Text("Watching")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(PsycheColor.muted)
                            } else {
                                Button("Watch") { watch(task) }
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(PsycheColor.muted)
                            }
                        }
                        ProgressBar(fraction: task.fraction)
                        EvidenceLine(["Step \(task.step) of \(task.stepCount)", task.detail, task.elapsed])
                    }
                }
            }
        }
    }

    /// Starts a Live Activity for the task; a quiet line says why when it can't.
    private func watch(_ task: RunningTask) {
        guard let alerts else { return }
        Task {
            if let message = await alerts.watch(task) { model.show(message, seconds: 5) }
        }
    }

    private func today(_ items: [BriefItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Today")
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider() }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        EvidenceLine(item.evidenceLabel, item.evidence)
                    }
                }
                Text("That's everything for today.")
                    .font(.system(.footnote, design: .serif).italic())
                    .foregroundStyle(PsycheColor.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 4)
            }
            .padding(.horizontal, 2)
        }
    }

    private func todos(_ title: String, _ items: [TodoItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title)
            PaperCard {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider() }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        EvidenceLine([item.meta])
                    }
                    .padding(PsycheMetrics.rowPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func keepInTouch(_ nudges: [Nudge]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Keep in touch")
            PaperCard {
                ForEach(Array(nudges.enumerated()), id: \.element.id) { index, nudge in
                    if index > 0 { HairlineDivider() }
                    nudgeRow(nudge)
                }
            }
        }
    }

    private func nudgeRow(_ nudge: Nudge) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                InitialsAvatar(nudge.initials, size: 36)
                Text(nudge.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
            }
            HStack(spacing: 20) {
                Button("Start a message") {
                    router.askPsyche(nudge.draft ?? "Help me reach out. \(nudge.text)")
                    Task { await model.act(on: nudge, .startMessage) }
                }
                .foregroundStyle(PsycheColor.inkText)
                Button("Snooze") { Task { await model.act(on: nudge, .snooze) } }
                Button("Mute") { Task { await model.act(on: nudge, .mute) } }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(PsycheColor.muted)
            .buttonStyle(.plain)
            .padding(.leading, 48)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Pinned

    /// Up to 6 widgets, below the fold, drawn by the native widget renderer (live, open and reply only).
    private func pinned(_ widgets: [WidgetSnapshot]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Pinned", count: widgets.count).id("pinned")
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(widgets) { widget in
                    WidgetView(snapshot: widget, backend: store, surface: .overview)
                }
            }
        }
    }

    // MARK: More

    private var more: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("More")
            PaperCard {
                moreRow("Inbox", systemImage: "tray", route: .inbox, trailing: model.unreadInbox > 0 ? "\(model.unreadInbox) new" : nil)
                HairlineDivider()
                moreRow("Scheduled", systemImage: "clock", route: .scheduled)
                HairlineDivider()
                moreRow("Overview", systemImage: "square.grid.2x2", route: .overview)
            }
        }
    }

    private func moreRow(_ title: String, systemImage: String, route: Route, trailing: String? = nil) -> some View {
        Button { router.homePath.append(route) } label: {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.body).foregroundStyle(PsycheColor.muted).frame(width: 22)
                    .accessibilityHidden(true)
                Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                Spacer(minLength: 0)
                if let trailing { Text(trailing).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted) }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PsycheColor.muted.opacity(0.7))
                    .accessibilityHidden(true)
            }
            .padding(PsycheMetrics.rowPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Notice

    @ViewBuilder
    private var notice: some View {
        if let message = model.notice {
            Text(message)
                .font(.subheadline)
                .foregroundStyle(PsycheColor.text)
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
                .padding(.bottom, 96)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }
}

extension NeedsYouItem.Kind {
    var label: String {
        switch self {
        case .approval: "Approval"
        case .question: "Question"
        case .task: "Task"
        }
    }
}
