import PsycheDesign
import PsycheStore
import SwiftUI

/// Draws one catalogue node. The spec is data and was validated by the Gateway, but every value is
/// still treated as untrusted: strings are text, markdown has no HTML, links are http/https/mailto
/// only, and nothing here takes a color, font or style from the spec.
struct WidgetNodeView: View {
    let node: WidgetNode

    var body: some View {
        switch node {
        case .stack(_, let stack): StackNodeView(stack: stack)
        case .grid(_, let grid):
            WidgetGridLayout(columns: grid.columns, spacing: grid.gap.points) {
                ForEach(grid.children) { WidgetNodeView(node: $0) }
            }
        case .tabs(_, let tabs): TabsNodeView(tabs: tabs)
        case .card(_, let card): CardNodeView(card: card)
        case .list(_, let rows): ListNodeView(nodeID: node.id, rows: rows)
        case .progress(_, let progress): ProgressNodeView(progress: progress)
        case .checklist(_, let items): ChecklistNodeView(items: items)
        case .timeline(_, let entries): TimelineNodeView(entries: entries)
        case .status(_, let label, let tone): StatusNodeView(label: label, tone: tone)
        case .stat(_, let stat): StatNodeView(stat: stat)
        case .kv(_, let rows): KVNodeView(rows: rows)
        case .table(_, let table): TableNodeView(table: table)
        case .chart(_, let chart): ChartNodeView(chart: chart)
        case .text(_, let text): TextNodeView(text: text)
        case .markdown(_, let markdown): WidgetMarkdown(source: markdown)
        case .code(_, let code): CodeNodeView(code: code)
        case .image(_, let image): ImageNodeView(image: image)
        case .map(_, let map): MapNodeView(map: map)
        case .link(_, let label, let url): LinkNodeView(label: label, url: url)
        case .button(_, let button): ButtonNodeView(nodeID: node.id, button: button)
        case .choices(_, let choices): ChoicesNodeView(nodeID: node.id, choices: choices)
        case .form(_, let form): FormNodeView(nodeID: node.id, form: form)
        case .unsupported(let meta, let type): UnsupportedNodeView(fallback: meta.fallbackText, type: type)
        }
    }
}

// MARK: Layout

private struct StackNodeView: View {
    let stack: StackNode

    var body: some View {
        if stack.horizontal {
            WidgetFlowLayout(spacing: stack.gap.points) {
                ForEach(stack.children) { WidgetNodeView(node: $0) }
            }
        } else {
            VStack(alignment: .leading, spacing: stack.gap.points) {
                ForEach(stack.children) { WidgetNodeView(node: $0) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TabsNodeView: View {
    let tabs: [TabNode]
    @State private var selection = 0

    var body: some View {
        let current = min(selection, max(0, tabs.count - 1))
        VStack(alignment: .leading, spacing: 10) {
            if tabs.count > 1 {
                Picker("Section", selection: $selection) {
                    ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in
                        Text(tab.label).tag(index)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            if tabs.indices.contains(current) {
                VStack(alignment: .leading, spacing: WidgetGap.sm.points) {
                    ForEach(tabs[current].children) { WidgetNodeView(node: $0) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(tabs[current].id)
            }
        }
    }
}

private struct CardNodeView: View {
    let card: CardNode

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = card.title {
                HStack(spacing: 6) {
                    ToneMark(tone: card.tone)
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.text)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            if let subtitle = card.subtitle {
                Text(subtitle).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
            VStack(alignment: .leading, spacing: WidgetGap.sm.points) {
                ForEach(card.children) { WidgetNodeView(node: $0) }
            }
            .padding(.top, card.title == nil && card.subtitle == nil ? 0 : 4)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PsycheColor.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(card.tone == .neutral ? PsycheColor.hairline : PsycheColor.rule, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }
}

// MARK: Data views

private struct ListNodeView: View {
    let nodeID: String
    let rows: [ListRow]

    var body: some View {
        if rows.isEmpty {
            Text("Nothing here.").font(.footnote).foregroundStyle(PsycheColor.muted)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { HairlineDivider() }
                    ListRowView(nodeID: nodeID, row: row)
                }
            }
        }
    }
}

private struct ListRowView: View {
    let nodeID: String
    let row: ListRow
    @State private var runner = ActionRunner()
    @Environment(\.widgetRuntime) private var runtime
    @Environment(\.widgetHandlers) private var handlers
    @Environment(\.openURL) private var openURL

    private var actionable: Bool { runtime?.isLive != false && runtime?.allows(row.action) == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if actionable, let action = row.action {
                Button {
                    Task {
                        await runner.run(
                            action, nodeID: nodeID, itemID: row.id, runtime: runtime, handlers: handlers, openURL: { openURL($0) })
                    }
                } label: { content(chevron: true) }
                .buttonStyle(.plain)
                .disabled(runner.isBusy)
                .accessibilityHint(runner.phase == .sent ? "Sent" : "")
            } else {
                content(chevron: false)
            }
            ControlError(message: runner.error)
        }
    }

    private func content(chevron: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(row.title).font(.subheadline).foregroundStyle(PsycheColor.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let meta = row.meta {
                Text(meta).font(.footnote).foregroundStyle(PsycheColor.muted)
            }
            if runner.phase == .working {
                ProgressView().controlSize(.small)
            } else if runner.phase == .sent {
                Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.muted)
            } else if chevron {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(PsycheColor.muted)
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

private struct ProgressNodeView: View {
    let progress: ProgressNode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var slide = false

    private var valueText: String {
        if let fraction = progress.fraction, let value = progress.value {
            "\(JSONValue.format(value)) of \(JSONValue.format(progress.max)) · \(Int((fraction * 100).rounded()))%"
        } else {
            "In progress"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ToneMark(tone: progress.tone)
                    Text(progress.label).font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.text)
                    Spacer(minLength: 8)
                    Text(valueText).font(.footnote).monospacedDigit().foregroundStyle(PsycheColor.muted)
                }
                // Graphite, never colored: progress is not a status.
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(PsycheColor.rule.opacity(0.7))
                        if let fraction = progress.fraction {
                            Capsule().fill(PsycheColor.text.opacity(0.85)).frame(width: max(6, proxy.size.width * fraction))
                        } else {
                            Capsule().fill(PsycheColor.text.opacity(0.85))
                                .frame(width: proxy.size.width / 3)
                                .offset(x: reduceMotion || !slide ? 0 : proxy.size.width * 2 / 3)
                        }
                    }
                }
                .frame(height: 6)
                .task(id: progress.indeterminate) {
                    guard progress.fraction == nil, !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { slide = true }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(progress.label)
            .accessibilityValue(valueText)

            if !progress.steps.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(progress.steps.enumerated()), id: \.offset) { _, step in
                        HStack(spacing: 8) {
                            Image(systemName: step.state.symbol).foregroundStyle(step.state.tint).font(.footnote)
                            Text(step.label).font(.footnote).foregroundStyle(PsycheColor.text)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(step.label), \(step.state.spokenName)")
                    }
                }
            }
        }
    }
}

private struct ChecklistNodeView: View {
    let items: [ChecklistItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: item.state.symbol).foregroundStyle(item.state.tint).font(.subheadline)
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.label).font(.subheadline)
                            .foregroundStyle(item.state == .done || item.state == .skipped ? PsycheColor.muted : PsycheColor.text)
                            .strikethrough(item.state == .done, color: PsycheColor.muted)
                        if let detail = item.detail {
                            Text(detail).font(.footnote).foregroundStyle(PsycheColor.muted)
                        }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(item.label), \(item.state.spokenName)" + (item.detail.map { ", \($0)" } ?? ""))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TimelineNodeView: View {
    let entries: [TimelineEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                HStack(alignment: .top, spacing: 12) {
                    Text(entry.time ?? "").font(.psycheMono(.footnote)).foregroundStyle(PsycheColor.muted)
                        .frame(width: 52, alignment: .leading)
                    ZStack(alignment: .top) {
                        if index < entries.count - 1 {
                            Rectangle().fill(PsycheColor.rule).frame(width: 1)
                                .padding(.top, 10).padding(.bottom, -4)
                        }
                        Circle().fill(PsycheColor.muted).frame(width: 7, height: 7).padding(.top, 6)
                    }
                    .frame(width: 7)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        ToneMark(tone: entry.tone)
                        Text(entry.label).font(.subheadline).foregroundStyle(PsycheColor.text)
                    }
                    .padding(.bottom, index < entries.count - 1 ? 12 : 0)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct StatusNodeView: View {
    let label: String
    let tone: WidgetTone

    var body: some View {
        HStack(spacing: 6) {
            if tone == .neutral {
                Circle().fill(PsycheColor.muted).frame(width: 7, height: 7).accessibilityHidden(true)
            } else {
                ToneMark(tone: tone)
            }
            Text(label).font(.footnote).foregroundStyle(PsycheColor.text)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .overlay(Capsule().strokeBorder(PsycheColor.rule, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

private struct StatNodeView: View {
    let stat: StatNode

    private var valueText: String {
        if let number = stat.number {
            number.formatted(.number.grouping(.automatic).precision(.fractionLength(0...2)))
        } else {
            stat.text
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(stat.label).font(.footnote).foregroundStyle(PsycheColor.muted)
                ToneMark(tone: stat.tone)
            }
            // The number stays graphite whatever the tone; the tone is the icon and the spoken word.
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(valueText).font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(PsycheColor.text)
                    .minimumScaleFactor(0.7).lineLimit(2)
                if let unit = stat.unit {
                    Text(unit).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
            }
            if let delta = stat.delta {
                Text(delta).font(.footnote).foregroundStyle(PsycheColor.muted)
                    .accessibilityLabel("Change: \(delta)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct KVNodeView: View {
    let rows: [KVRow]

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    Text(row.label).font(.footnote).foregroundStyle(PsycheColor.muted)
                        .frame(maxWidth: 140, alignment: .leading)
                    Text(row.value).font(.subheadline).foregroundStyle(PsycheColor.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct TextNodeView: View {
    let text: TextNode

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if text.tone != .neutral { ToneMark(tone: text.tone) }
            Text(text.text)
                .font(.subheadline.weight(text.strong ? .semibold : .regular))
                .foregroundStyle(PsycheColor.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct LinkNodeView: View {
    let label: String
    let url: String

    var body: some View {
        if let safe = WidgetLink.safeURL(url) {
            Link(destination: safe) {
                Label(label, systemImage: "arrow.up.right").labelStyle(.titleAndIcon).font(.subheadline)
                    .foregroundStyle(PsycheColor.inkText)
            }
            .accessibilityHint("Opens in your browser")
        } else {
            Text(label).font(.subheadline).foregroundStyle(PsycheColor.text)
        }
    }
}

private struct UnsupportedNodeView: View {
    let fallback: String?
    let type: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let fallback, !fallback.isEmpty {
                Text(fallback).font(.subheadline).foregroundStyle(PsycheColor.text)
            }
            Label("Open on your Mac to see this part", systemImage: "macbook.and.iphone")
                .font(.footnote).foregroundStyle(PsycheColor.muted)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(PsycheColor.rule, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
        .accessibilityElement(children: .combine)
    }
}
