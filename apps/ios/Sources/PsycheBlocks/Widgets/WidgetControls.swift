import PsycheDesign
import PsycheStore
import SwiftUI

// Buttons, choices and forms (generative-ui-2026 §6). Every control is host-drawn: the spec supplies
// the words and the action, this file decides what a tap does. Nothing runs on render, a timer or
// focus. At most one control per widget wears the ink fill (its primary button).

extension WidgetNode {
    /// The control that gets the ink fill: the first button with a runnable action, else the first form
    /// (document order, tabs included). Everything else is outlined.
    func findPrimaryControl() -> String? {
        var firstForm: String?
        func walk(_ node: WidgetNode) -> String? {
            if case .button(let meta, let button) = node, button.action != nil, button.tone != .danger { return meta.id }
            if case .form(let meta, _) = node, firstForm == nil { firstForm = meta.id }
            switch node {
            case .stack(_, let n): return n.children.lazy.compactMap(walk).first
            case .grid(_, let n): return n.children.lazy.compactMap(walk).first
            case .card(_, let n): return n.children.lazy.compactMap(walk).first
            case .tabs(_, let tabs): return tabs.lazy.flatMap(\.children).compactMap(walk).first
            default: return nil
            }
        }
        return walk(self) ?? firstForm
    }
}

// MARK: Button

struct ButtonNodeView: View {
    let nodeID: String
    let button: ButtonNode
    @State private var runner = ActionRunner()
    @Environment(\.widgetRuntime) private var runtime
    @Environment(\.widgetHandlers) private var handlers
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let action = button.action, runtime?.allows(action) == true {
            VStack(alignment: .leading, spacing: 4) {
                if case .open(_, _, _, let url?) = action, let safe = WidgetLink.safeURL(url) {
                    Link(destination: safe) { Text(button.label) }
                        .buttonStyle(WidgetButtonStyle(prominent: false))
                } else {
                    Button {
                        Task {
                            await runner.run(
                                action, nodeID: nodeID, runtime: runtime, handlers: handlers,
                                openURL: { openURL($0) })
                        }
                    } label: {
                        HStack(spacing: 8) {
                            ToneMark(tone: button.tone)
                            Text(button.label)
                            switch runner.phase {
                            case .working: ProgressView().controlSize(.small)
                            case .sent: Image(systemName: "checkmark").font(.footnote.weight(.bold))
                            case .idle: EmptyView()
                            }
                        }
                    }
                    .buttonStyle(WidgetButtonStyle(prominent: runtime?.primaryControlID == nodeID))
                    .disabled(runner.isBusy || runtime?.isLive == false)
                    .accessibilityHint(runner.phase == .sent ? "Sent" : "")
                }
                ControlError(message: runner.error)
            }
        }
    }
}

// MARK: Choices

struct ChoicesNodeView: View {
    let nodeID: String
    let choices: ChoicesNode
    @State private var picked: [String] = []
    @State private var runner = ActionRunner()
    @Environment(\.widgetRuntime) private var runtime
    @Environment(\.widgetHandlers) private var handlers
    @Environment(\.openURL) private var openURL

    /// Only reply and answer actions make sense for a choice; `ask` (a real InputRequest) is a later phase.
    private var action: WidgetAction? {
        guard let action = choices.action, !choices.ask, runtime?.surface != .feed else { return nil }
        switch action {
        case .reply, .answer: return action
        default: return nil
        }
    }

    private func label(for id: String) -> String { choices.options.first { $0.id == id }?.label ?? "" }

    var body: some View {
        if let action, runtime?.allows(action) == true {
            VStack(alignment: .leading, spacing: 6) {
                Text(choices.label).font(.footnote).foregroundStyle(PsycheColor.muted)
                    .accessibilityAddTraits(.isHeader)
                VStack(spacing: 0) {
                    ForEach(Array(choices.options.enumerated()), id: \.element.id) { index, option in
                        if index > 0 { HairlineDivider() }
                        let on = picked.contains(option.id)
                        Button { toggle(option.id) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: choices.multiple ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                                    .foregroundStyle(on ? PsycheColor.text : PsycheColor.muted)
                                Text(option.label).font(.subheadline).foregroundStyle(PsycheColor.text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                        .accessibilityLabel(option.label)
                    }
                }
                Button { submit(action) } label: {
                    HStack(spacing: 8) {
                        Text("Send")
                        if runner.phase == .working { ProgressView().controlSize(.small) }
                        if runner.phase == .sent { Image(systemName: "checkmark").font(.footnote.weight(.bold)) }
                    }
                }
                .buttonStyle(WidgetButtonStyle())
                .disabled(picked.isEmpty || runner.isBusy || runtime?.isLive == false)
                ControlError(message: runner.error)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(choices.label)
        }
    }

    private func toggle(_ id: String) {
        runner.clearError()
        if choices.multiple {
            if let index = picked.firstIndex(of: id) { picked.remove(at: index) } else { picked.append(id) }
        } else {
            picked = [id]
        }
    }

    private func submit(_ action: WidgetAction) {
        let labels = picked.map(label(for:))
        let composed: WidgetAction
        switch action {
        case .reply(let text):
            composed = .reply(text: [text, labels.joined(separator: ", ")].filter { !$0.isEmpty }.joined(separator: ": "))
        case .answer(let request, _):
            composed = .answer(inputRequestID: request, values: choices.multiple ? labels : Array(labels.prefix(1)))
        default:
            return
        }
        Task {
            await runner.run(
                composed, nodeID: nodeID, runtime: runtime, handlers: handlers,
                openURL: { openURL($0) })
        }
    }
}

// MARK: Form

struct FormNodeView: View {
    let nodeID: String
    let form: FormNode
    @State private var text: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var dates: [String: Date] = [:]
    @State private var errors: [String: String] = [:]
    @State private var runner = ActionRunner()
    @FocusState private var focused: String?
    @Environment(\.widgetRuntime) private var runtime
    @Environment(\.widgetHandlers) private var handlers
    @Environment(\.openURL) private var openURL

    private var isTool: Bool { form.submit == .tool }

    var body: some View {
        if form.submit != nil, runtime?.surface != .feed {
            VStack(alignment: .leading, spacing: 12) {
                Text(form.label).font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.text)
                    .accessibilityAddTraits(.isHeader)
                ForEach(form.fields) { field in fieldView(field) }
                Button { submit() } label: {
                    HStack(spacing: 8) {
                        Text(form.submitLabel)
                        if runner.phase == .working { ProgressView().controlSize(.small) }
                        if runner.phase == .sent { Image(systemName: "checkmark").font(.footnote.weight(.bold)) }
                    }
                }
                .buttonStyle(WidgetButtonStyle(prominent: runtime?.primaryControlID == nodeID))
                .disabled(runner.isBusy || runtime?.isLive == false)
                ControlError(message: runner.error)
            }
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: Fields

    @ViewBuilder private func fieldView(_ field: FormField) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if field.kind == .toggle {
                Toggle(isOn: Binding(get: { flags[field.id] ?? false }, set: { flags[field.id] = $0 })) {
                    Text(label(field)).font(.subheadline).foregroundStyle(PsycheColor.text)
                }
                .tint(PsycheColor.text)
                .frame(minHeight: 44)
            } else {
                Text(label(field)).font(.footnote).foregroundStyle(PsycheColor.muted)
                input(field)
            }
            if let error = errors[field.id] {
                Text(error).font(.footnote).foregroundStyle(PsycheColor.red)
                    .accessibilityLabel("\(field.label): \(error)")
            }
        }
    }

    private func label(_ field: FormField) -> String { field.required ? "\(field.label) (required)" : field.label }

    @ViewBuilder private func input(_ field: FormField) -> some View {
        let binding = Binding(get: { text[field.id] ?? "" }, set: { text[field.id] = $0; errors[field.id] = nil; runner.clearError() })
        switch field.kind {
        case .textarea:
            TextField(field.placeholder ?? "", text: binding, axis: .vertical)
                .lineLimit(3...6)
                .focused($focused, equals: field.id)
                .fieldBox(invalid: errors[field.id] != nil)
        case .select:
            Picker(field.label, selection: binding) {
                Text("Choose…").tag("")
                ForEach(field.options) { Text($0.label).tag($0.id) }
            }
            .pickerStyle(.menu)
            .tint(PsycheColor.text)
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .fieldBox(invalid: errors[field.id] != nil)
        case .number:
            TextField(field.placeholder ?? "", text: binding)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
                .focused($focused, equals: field.id)
                .fieldBox(invalid: errors[field.id] != nil)
        case .date:
            DatePicker(
                field.label,
                selection: Binding(
                    get: { dates[field.id] ?? Date() },
                    set: { dates[field.id] = $0; text[field.id] = $0.formatted(.iso8601.year().month().day()); errors[field.id] = nil }),
                displayedComponents: .date
            )
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .fieldBox(invalid: errors[field.id] != nil)
        case .text, .toggle:
            TextField(field.placeholder ?? "", text: binding)
                .focused($focused, equals: field.id)
                .fieldBox(invalid: errors[field.id] != nil)
        }
    }

    // MARK: Submit

    private func typedValue(_ field: FormField) -> JSONValue? {
        switch field.kind {
        case .toggle: return flags[field.id].map(JSONValue.bool)
        case .number:
            let raw = (text[field.id] ?? "").trimmingCharacters(in: .whitespaces)
            guard !raw.isEmpty else { return nil }
            return Double(raw.replacingOccurrences(of: ",", with: ".")).map(JSONValue.number) ?? .string(raw)
        case .date:
            return dates[field.id] != nil ? text[field.id].map(JSONValue.string) : nil
        default:
            let raw = text[field.id] ?? ""
            return raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : .string(raw)
        }
    }

    private func typedValues() -> [String: JSONValue] {
        var values: [String: JSONValue] = [:]
        for field in form.fields { if let value = typedValue(field) { values[field.id] = value } }
        return values
    }

    private func validate() -> Bool {
        let found = form.errors(for: typedValues())
        errors = found
        if let first = form.fields.first(where: { found[$0.id] != nil }) { focused = first.id }
        return found.isEmpty
    }

    private func submit() {
        guard validate() else { return }
        let values = typedValues()
        let action: WidgetAction
        if isTool {
            // The Gateway builds the call from the stored spec; only what was typed goes with it.
            action = .tool(name: form.tool ?? "", args: [:])
        } else {
            // The template is the spec's words, the lines are what was typed: both appear in the chat.
            let lines = form.fields.compactMap { field -> String? in
                guard let value = values[field.id] else { return nil }
                let shown: String
                switch field.kind {
                case .toggle: shown = value.boolValue == true ? "Yes" : "No"
                case .select: shown = field.options.first { $0.id == value.text }?.label ?? value.text
                default: shown = value.text
                }
                return "\(field.label): \(shown)"
            }
            let message = ([form.template ?? ""] + lines).filter { !$0.isEmpty }.joined(separator: "\n")
            guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            action = .reply(text: message)
        }
        Task {
            await runner.run(
                action, nodeID: nodeID, values: isTool ? values : [:], runtime: runtime, handlers: handlers, openURL: { openURL($0) })
            if runner.error == nil, runner.phase != .idle { text = [:]; flags = [:]; dates = [:] }
        }
    }
}

extension FormNode {
    /// Inline validation: a required field left empty, or text in a number field.
    func errors(for values: [String: JSONValue]) -> [String: String] {
        var found: [String: String] = [:]
        for field in fields {
            let value = values[field.id]
            if field.required, field.kind != .toggle, value == nil { found[field.id] = "\(field.label) is required." }
            if field.kind == .number, case .string? = value { found[field.id] = "Enter a number." }
        }
        return found
    }
}

private extension View {
    /// An outlined input box on the widget's sheet.
    func fieldBox(invalid: Bool) -> some View {
        self
            .font(.subheadline)
            .foregroundStyle(PsycheColor.text)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(PsycheColor.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(invalid ? PsycheColor.red : PsycheColor.rule, lineWidth: 1))
    }
}
