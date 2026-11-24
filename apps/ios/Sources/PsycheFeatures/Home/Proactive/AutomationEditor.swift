import PsycheDesign
import PsycheStore
import SwiftUI

/// The automation editor's state: the draft, the automation it edits (nil for a new one), and the Gateway's words when
/// it refuses a save or a delete. Save is off until the draft has no problems.
@MainActor @Observable
final class AutomationEditorModel {
    enum Phase: Equatable {
        case loading
        case ready
        /// Triggered by an event or a watch: the phone shows it but does not write its schedule.
        case readOnly
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var detail: AutomationDetail?
    var draft = AutomationDraft(schedule: AutomationSchedule()) {
        didSet { if draft.prompt != oldValue.prompt { isPromptTouched = true } }
    }
    /// True once the prompt has been edited. Loading a draft resets it, so a new editor starts without a red hint.
    private(set) var isPromptTouched = false
    /// The prompt hint: "empty" once the owner has edited the prompt and it is empty; "too long" whenever it is over
    /// the limit. Nil when the prompt is fine.
    var promptHint: AutomationPromptProblem? {
        switch draft.promptProblem {
        case .empty: return isPromptTouched ? .empty : nil
        case .tooLong: return .tooLong
        case nil: return nil
        }
    }
    private(set) var saving = false
    private(set) var failure: String?
    let automationID: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend, automationID: String?) {
        self.store = store
        self.automationID = automationID
    }

    var isNew: Bool { automationID == nil }
    var zone: TimeZone { detail?.zone ?? .current }
    var problems: AutomationDraftProblems { draft.problems(zone: zone, now: Date(), editingKind: detail?.kind) }
    /// Whether the draft differs from the automation as it is now. A new automation always has something to save.
    var hasChanges: Bool {
        guard let detail else { return true }
        guard case .success(let changes) = draft.changes(from: detail, now: Date()) else { return false }
        return !changes.isEmpty
    }
    /// Save is on once there is something to save and it is valid. An existing automation opened unchanged stays off.
    var canSave: Bool { phase == .ready && !saving && problems.isEmpty && hasChanges }
    /// The kinds the Repeats picker offers for this automation.
    var presetChoices: [AutomationPreset] { AutomationSchedule.choices(editingKind: detail?.kind, current: draft.schedule.preset) }

    func load() async {
        guard let automationID else {
            draft = AutomationDraft(schedule: AutomationSchedule.defaults(now: Date(), zone: .current))
            isPromptTouched = false
            phase = .ready
            return
        }
        do {
            let found = try await store.automation(id: automationID)
            detail = found
            draft = AutomationDraft(found)
            isPromptTouched = false
            phase = found.isFormKind ? .ready : .readOnly
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Creates the automation, or sends the changed fields of an existing one. True when the Gateway took it.
    func save() async -> Bool {
        guard canSave else { return false }
        saving = true
        failure = nil
        defer { saving = false }
        let now = Date()
        do {
            if let detail {
                guard case .success(let changes) = draft.changes(from: detail, now: now) else { return false }
                try await store.updateAutomation(id: detail.id, changes: changes)
            } else {
                guard case .success(let create) = draft.create(zone: .current, now: now) else { return false }
                _ = try await store.createAutomation(create)
            }
            return true
        } catch {
            failure = error.localizedDescription
            return false
        }
    }

    /// Deletes the automation being edited. True when the Gateway removed it.
    func delete() async -> Bool {
        guard let detail, !saving else { return false }
        saving = true
        failure = nil
        defer { saving = false }
        do {
            try await store.deleteAutomation(id: detail.id)
            return true
        } catch {
            failure = error.localizedDescription
            return false
        }
    }
}

/// "New automation" and "Edit automation": what to do, when, and whether it is on. Saving closes the sheet and tells
/// the Scheduled screen to reload.
struct AutomationEditorSheet: View {
    let onFinish: () -> Void
    @State private var model: AutomationEditorModel
    @State private var confirmingDelete = false
    @Environment(\.dismiss) private var dismiss

    init(store: any PsycheBackend, automationID: String?, onFinish: @escaping () -> Void) {
        _model = State(initialValue: AutomationEditorModel(store: store, automationID: automationID))
        self.onFinish = onFinish
    }

    private var title: String {
        model.isNew ? String(localized: "New automation", bundle: .module) : String(localized: "Edit automation", bundle: .module)
    }

    var body: some View {
        NavigationStack {
            Form {
                switch model.phase {
                case .loading:
                    Section { ProgressView() }
                case .failed(let message):
                    Section { Text(message).foregroundStyle(PsycheColor.red) }
                case .readOnly:
                    Section {
                        Text("This runs on an event or a watch, so edit it on your Mac.", bundle: .module)
                            .foregroundStyle(PsycheColor.muted)
                    }
                case .ready:
                    editorSections
                }
            }
            .task { await model.load() }
            .navigationTitle(title)
            .psycheInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel", bundle: .module)) { dismiss() }
                        .disabled(model.saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save", bundle: .module)) {
                        Task { if await model.save() { onFinish(); dismiss() } }
                    }
                    .disabled(!model.canSave)
                }
            }
            .confirmationDialog(
                String(localized: "Delete this automation?", bundle: .module),
                isPresented: $confirmingDelete, titleVisibility: .visible
            ) {
                Button(String(localized: "Delete", bundle: .module), role: .destructive) {
                    Task { if await model.delete() { onFinish(); dismiss() } }
                }
                Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
            } message: {
                Text("It won't run again, and this can't be undone.", bundle: .module)
            }
        }
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var editorSections: some View {
        Section {
            TextField(String(localized: "Name, optional", bundle: .module), text: $model.draft.title)
                .accessibilityIdentifier("automationName")
            TextField(String(localized: "What should it do?", bundle: .module), text: $model.draft.prompt, axis: .vertical)
                .lineLimit(3...12)
                .accessibilityIdentifier("automationPrompt")
        } footer: {
            switch model.promptHint {
            case .empty:
                Text("Write what it should do.", bundle: .module).foregroundStyle(PsycheColor.red)
            case .tooLong:
                Text("Keep it under 20,000 characters.", bundle: .module).foregroundStyle(PsycheColor.red)
            case nil:
                EmptyView()
            }
        }

        Section {
            Picker(String(localized: "Repeats", bundle: .module), selection: presetBinding) {
                ForEach(model.presetChoices) { preset in
                    Text(Self.presetLabel(preset)).tag(preset)
                }
            }
            scheduleDetail
        } header: {
            Text("When", bundle: .module)
        } footer: {
            if let problem = model.problems.schedule, let text = Self.problemText(problem) {
                Text(text).foregroundStyle(PsycheColor.red)
            }
        }

        // The next three runs, worked out on the phone in the automation's zone. Nothing for a custom schedule the
        // picker cannot read, or a one-time time that has gone.
        if let runs = model.draft.schedule.nextRuns(zone: model.zone, now: Date()), !runs.isEmpty {
            Section {
                ForEach(runs, id: \.self) { run in
                    Text(Self.runText(run, zone: model.zone))
                }
            } header: {
                Text("Next runs", bundle: .module)
            }
        }

        if model.draft.schedule.preset == .weekly {
            Section {
                ForEach(0..<7, id: \.self) { day in
                    Toggle(Calendar.current.weekdaySymbols[day], isOn: dayBinding(day))
                }
            }
        }

        Section {
            Toggle(String(localized: "Enabled", bundle: .module), isOn: $model.draft.enabled)
        } footer: {
            if let failure = model.failure {
                Text(failure).foregroundStyle(PsycheColor.red)
            }
        }

        if !model.isNew {
            Section {
                Button(String(localized: "Delete automation", bundle: .module), role: .destructive) { confirmingDelete = true }
            }
        }
    }

    @ViewBuilder private var scheduleDetail: some View {
        switch model.draft.schedule.preset {
        case .once:
            DatePicker(
                String(localized: "Date and time", bundle: .module), selection: $model.draft.schedule.onceAt,
                displayedComponents: [.date, .hourAndMinute])
        case .daily, .weekdays, .weekly:
            DatePicker(String(localized: "Time", bundle: .module), selection: timeBinding, displayedComponents: .hourAndMinute)
                .environment(\.timeZone, model.zone)
        case .interval:
            Stepper(value: $model.draft.schedule.intervalHours, in: 1...168) {
                Text("Every \(model.draft.schedule.intervalHours) hours", bundle: .module)
            }
        case .custom:
            LabeledContent(String(localized: "Custom schedule", bundle: .module)) {
                Text(model.draft.schedule.customText).foregroundStyle(PsycheColor.muted)
            }
        }
    }

    /// Switching to Once starts it at the next whole hour in the automation's zone. Picking the choice already shown
    /// keeps the time the owner set.
    private var presetBinding: Binding<AutomationPreset> {
        Binding(
            get: { model.draft.schedule.preset },
            set: { preset in
                let switchingToOnce = preset == .once && model.draft.schedule.preset != .once
                model.draft.schedule.preset = preset
                if switchingToOnce {
                    model.draft.schedule.onceAt = AutomationSchedule.nextWholeHour(now: Date(), zone: model.zone)
                }
            })
    }

    /// The picked time, as minutes after midnight in the zone the schedule is written in.
    private var timeBinding: Binding<Date> {
        Binding(
            get: {
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = model.zone
                let minute = model.draft.schedule.minuteOfDay
                return calendar.date(bySettingHour: minute / 60, minute: minute % 60, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = model.zone
                let parts = calendar.dateComponents([.hour, .minute], from: date)
                model.draft.schedule.minuteOfDay = (parts.hour ?? 9) * 60 + (parts.minute ?? 0)
            })
    }

    private func dayBinding(_ day: Int) -> Binding<Bool> {
        Binding(
            get: { model.draft.schedule.weekdays.contains(day) },
            set: { on in
                if on { model.draft.schedule.weekdays.insert(day) } else { model.draft.schedule.weekdays.remove(day) }
            })
    }

    /// A run as a short date and time in the automation's zone, so the preview reads the same as the schedule above it.
    private static func runText(_ date: Date, zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = zone
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private static func presetLabel(_ preset: AutomationPreset) -> String {
        switch preset {
        case .once: return String(localized: "Once", bundle: .module)
        case .daily: return String(localized: "Every day", bundle: .module)
        case .weekdays: return String(localized: "Weekdays", bundle: .module)
        case .weekly: return String(localized: "On chosen days", bundle: .module)
        case .interval: return String(localized: "Every few hours", bundle: .module)
        case .custom: return String(localized: "Custom", bundle: .module)
        }
    }

    /// The words under the schedule. Nil for `switchKind`: the Repeats picker never offers the swap, so the form
    /// cannot reach it.
    private static func problemText(_ problem: AutomationScheduleProblem) -> String? {
        switch problem {
        case .past: return String(localized: "Pick a time that is still ahead.", bundle: .module)
        case .noDays: return String(localized: "Choose at least one day.", bundle: .module)
        case .hours: return String(localized: "Pick between 1 and 168 hours.", bundle: .module)
        case .switchKind: return nil
        case .emptyCustom: return String(localized: "Enter a schedule.", bundle: .module)
        }
    }
}
