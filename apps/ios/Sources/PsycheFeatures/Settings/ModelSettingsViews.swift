import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

/// The default chat model: the list the Gateway reports, and the change through `models.setRole`.
@MainActor @Observable
final class DefaultModelModel {
    private(set) var phase: LoadPhase<ModelChoices> = .idle
    /// The ref being saved right now; nil when no change is in flight.
    private(set) var choosing: String?
    /// The Gateway's own words when it refuses a change (for example, no admin access on this phone).
    private(set) var refusal: String?
    private let store: any ModelsBackend

    init(store: any ModelsBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.modelChoices())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) } else { refusal = error.localizedDescription }
        }
    }

    /// Sets the default model, then reads the list again so the screen shows what the Gateway kept.
    func choose(_ ref: String) async {
        guard choosing == nil else { return }
        choosing = ref
        refusal = nil
        defer { choosing = nil }
        do {
            try await store.setDefaultModel(ref)
            await load()
        } catch {
            refusal = error.localizedDescription
        }
    }
}

/// Usage from the Gateway's `usage.summary`: read-only, today, this month and the last 7 days by model.
@MainActor @Observable
final class UsageModel {
    private(set) var phase: LoadPhase<UsageReport> = .idle
    private let store: any ModelsBackend

    init(store: any ModelsBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.usage())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }
}

struct DefaultModelView: View {
    @State private var model: DefaultModelModel

    init(store: any ModelsBackend) {
        _model = State(initialValue: DefaultModelModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                switch model.phase {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                case .loaded(let choices):
                    content(choices)
                case .failed(let message):
                    failure(message) { Task { await model.load() } }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .psycheScreen()
        .navigationTitle(String(localized: "Default model", bundle: .module))
        .psycheInlineTitle()
        .task { await model.load() }
    }

    @ViewBuilder
    private func content(_ choices: ModelChoices) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Models", bundle: .module))
            PaperStack {
                if choices.models.isEmpty {
                    Text("Your Mac doesn't list any models yet.", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(PsycheMetrics.rowPadding)
                } else {
                    ForEach(Array(choices.models.enumerated()), id: \.element.id) { index, choice in
                        VStack(spacing: 0) {
                            modelRow(choice, isDefault: choice.ref == choices.defaultRef)
                            if index < choices.models.count - 1 { HairlineDivider() }
                        }
                    }
                }
            }
            Text("Changing the default model needs admin access on this phone. If your Mac refuses, its reason appears below.", bundle: .module)
                .font(.footnote).foregroundStyle(PsycheColor.muted).padding(.horizontal, 2)
            if let refusal = model.refusal {
                Text(refusal)
                    .font(.subheadline).foregroundStyle(PsycheColor.red)
                    .padding(.horizontal, 2)
                    .accessibilityIdentifier("defaultModelRefusal")
            }
        }
    }

    private func modelRow(_ choice: ModelChoice, isDefault: Bool) -> some View {
        Button {
            Task { await model.choose(choice.ref) }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.ref).font(.psycheRow).foregroundStyle(PsycheColor.text)
                    Text(choice.providerLabel).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                Spacer(minLength: 12)
                if model.choosing == choice.ref {
                    ProgressView()
                } else if isDefault {
                    Text("Default", bundle: .module).font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.text)
                }
            }
            .padding(PsycheMetrics.rowPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.choosing != nil || isDefault)
        .accessibilityAddTraits(isDefault ? .isSelected : [])
    }

    private func failure(_ message: String, retry: @escaping () -> Void) -> some View {
        VStack(spacing: 12) {
            Text("Couldn't load this", bundle: .module).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
            Button(String(localized: "Try again", bundle: .module), action: retry)
                .buttonStyle(.psycheOutline).frame(maxWidth: 220)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 40)
    }
}

struct UsageView: View {
    @State private var model: UsageModel

    init(store: any ModelsBackend) {
        _model = State(initialValue: UsageModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                switch model.phase {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                case .loaded(let report):
                    content(report)
                case .failed(let message):
                    VStack(spacing: 12) {
                        Text("Couldn't load this", bundle: .module).font(.headline)
                        Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                            .buttonStyle(.psycheOutline).frame(maxWidth: 220)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .psycheScreen()
        .navigationTitle(String(localized: "Usage", bundle: .module))
        .psycheInlineTitle()
        .task { await model.load() }
    }

    @ViewBuilder
    private func content(_ report: UsageReport) -> some View {
        totalsSection(String(localized: "Today", bundle: .module), report.today)
        totalsSection(String(localized: "This month", bundle: .module), report.month)

        if let budget = report.budgetUsd {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(String(localized: "Monthly budget", bundle: .module))
                PaperStack {
                    valueRow(String(localized: "Budget", bundle: .module), Self.money(budget), last: true)
                }
            }
        }

        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(String(localized: "Last 7 days, by model", bundle: .module))
            PaperStack {
                if report.byModel.isEmpty {
                    Text("No usage yet.", bundle: .module)
                        .font(.subheadline).foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(PsycheMetrics.rowPadding)
                } else {
                    ForEach(Array(report.byModel.enumerated()), id: \.element.id) { index, row in
                        VStack(spacing: 0) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(row.modelRef).font(.psycheRow).foregroundStyle(PsycheColor.text)
                                Text(Self.summary(row.totals, subscription: row.subscription))
                                    .font(.footnote).foregroundStyle(PsycheColor.muted)
                            }
                            .padding(PsycheMetrics.rowPadding)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityElement(children: .combine)
                            if index < report.byModel.count - 1 { HairlineDivider() }
                        }
                    }
                }
            }
        }
    }

    private func totalsSection(_ title: String, _ totals: UsageTotals) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title)
            PaperStack {
                valueRow(String(localized: "Tokens", bundle: .module), totals.tokens.formatted())
                HairlineDivider()
                valueRow(String(localized: "Cost", bundle: .module), Self.money(totals.costUsd))
                HairlineDivider()
                valueRow(String(localized: "Turns", bundle: .module), totals.turns.formatted(), last: true)
            }
        }
    }

    private func valueRow(_ title: String, _ value: String, last: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).font(.psycheRow).foregroundStyle(PsycheColor.text)
            Spacer(minLength: 12)
            Text(value).font(.subheadline).foregroundStyle(PsycheColor.muted).monospacedDigit()
        }
        .padding(PsycheMetrics.rowPadding)
        .accessibilityElement(children: .combine)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func money(_ amount: Double) -> String {
        amount.formatted(.currency(code: "USD"))
    }

    /// "1,200 tokens · $0.42 · 12 turns"; a subscription model shows no cost, since its plan has no per-token price.
    static func summary(_ totals: UsageTotals, subscription: Bool) -> String {
        let tokens = totals.tokens.formatted()
        let turns = totals.turns.formatted()
        if subscription {
            return "\(tokens) \u{00B7} \(turns)"
        }
        return "\(tokens) \u{00B7} \(money(totals.costUsd)) \u{00B7} \(turns)"
    }
}
