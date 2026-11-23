import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// Home's Overview page: what the agent has been doing. Reads `AgentBackend.activity()`; opening a run's trace is a Mac thing.
/// Scheduled lives in `Proactive/ProactiveViews.swift`.
struct OverviewView: View {
    @State private var model: AgentModel

    init(store: any PsycheBackend) {
        _model = State(initialValue: AgentModel(store: store))
    }

    var body: some View {
        MorePage(title: "Overview", model: model) { activity in
            if !activity.now.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(String(localized: "Running", bundle: .module))
                    PaperCard {
                        ForEach(Array(activity.now.enumerated()), id: \.element.id) { index, task in
                            if index > 0 { HairlineDivider() }
                            VStack(alignment: .leading, spacing: 10) {
                                Text(task.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                ProgressBar(fraction: task.fraction)
                                EvidenceLine([String(localized: "Step \(task.step) of \(task.stepCount)", bundle: .module), task.detail, task.elapsed])
                            }
                            .padding(PsycheMetrics.rowPadding)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(String(localized: "Recent runs", bundle: .module))
                if activity.recent.isEmpty {
                    Text("No runs yet.", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
                } else {
                    PaperCard {
                        ForEach(Array(activity.recent.enumerated()), id: \.element.id) { index, run in
                            if index > 0 { HairlineDivider() }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(run.title).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                HStack(spacing: 8) {
                                    StatusDot(run.outcome.dot, run.outcome.label)
                                    EvidenceLine([run.time])
                                }
                            }
                            .padding(PsycheMetrics.rowPadding)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
        }
    }
}

/// A pushed page with the paper background, the connection banner, a skeleton and pull to refresh.
private struct MorePage<Content: View>: View {
    let title: String
    let model: AgentModel
    @ViewBuilder let content: (AgentActivity) -> Content
    @Environment(Session.self) private var session

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                ConnectionBanner(state: session.state, lastSyncedAt: session.lastSyncedAt)
                PhaseView(phase: model.phase, skeleton: .skeleton, retry: model.load) { activity in
                    content(activity)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .navigationTitle(title)
        .psycheInlineTitle()
        .psycheShowsNavigationBar()
        .task {
            await model.load()
            await model.observe()
        }
        .refreshable { await model.load() }
    }
}
