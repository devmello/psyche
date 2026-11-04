import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

struct HomeView: View {
    @State private var model: HomeModel
    @State private var ask = ""
    @Environment(Session.self) private var session
    @Environment(Router.self) private var router

    init(store: any SnapshotStore) {
        _model = State(initialValue: HomeModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                PageHeader("Home", eyebrow: Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day())) {
                    AgentButton(needsYou: !(model.phase.value?.needsYou.isEmpty ?? true))
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
        .task { await model.load() }
        .refreshable { await model.resync() }
    }

    private var askField: some View {
        HStack(spacing: 10) {
            TextField("Ask Psyche anything", text: $ask)
                .font(.callout)
                .submitLabel(.send)
                .onSubmit(submitAsk)
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

    @ViewBuilder
    private func sections(_ snapshot: HomeSnapshot) -> some View {
        if !snapshot.needsYou.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Needs you", count: snapshot.needsYou.count, needsYou: true)
                PaperCard {
                    ForEach(Array(snapshot.needsYou.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { HairlineDivider() }
                        needsYouRow(item)
                    }
                }
            }
        }
        if !snapshot.running.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Running")
                ForEach(snapshot.running) { task in runningCard(task) }
            }
        }
        if !snapshot.today.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Today")
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(snapshot.today.enumerated()), id: \.element.id) { index, item in
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
        if !snapshot.keepInTouch.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Keep in touch")
                PaperCard(padding: 14) {
                    ForEach(snapshot.keepInTouch) { nudge in
                        HStack(spacing: 12) {
                            InitialsAvatar(nudge.initials, size: 36)
                            Text(nudge.text).font(.psycheRow).foregroundStyle(PsycheColor.text)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func needsYouRow(_ item: NeedsYouItem) -> some View {
        let canAnswer = session.state.canAnswer
        let kind = item.kind == .approval ? "Approval" : item.kind == .question ? "Question" : "Task"
        let evidence = canAnswer ? [kind, item.source, item.time] : [kind, "reconnect to answer"]
        let row = NeedsYouRow(title: item.title, evidence: evidence, showsChevron: canAnswer)
        if canAnswer {
            Button { open(item) } label: { row }.buttonStyle(.plain)
        } else {
            row
        }
    }

    private func open(_ item: NeedsYouItem) {
        if item.approval != nil {
            router.sheet = .approval(item)
        } else if let thread = item.threadID {
            router.openThread(thread)
        }
    }

    private func runningCard(_ task: RunningTask) -> some View {
        PaperCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(task.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    Spacer(minLength: 0)
                    if let thread = router.runningThread(for: task.id) {
                        Button("Watch") { router.openThread(thread) }
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
