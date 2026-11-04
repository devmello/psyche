import Charts
import MapKit
import PsycheDesign
import PsycheStore
import SwiftUI

// Table, chart, map, code, image: the data-heavy nodes.

// MARK: Table

struct TableNodeView: View {
    let table: TableNode
    @State private var sortKey: String?
    @State private var ascending = true
    @State private var expanded = false

    /// Rows drawn before "Show all" (WIDGET_LIMITS.tableRowsShown on the desktop).
    private static let shownRows = 25

    private var rows: [[String: JSONValue]] {
        guard let sortKey else { return table.rows }
        return table.rows.sorted { a, b in
            let x = a[sortKey], y = b[sortKey]
            let order: Bool
            if let x = x?.numberValue, let y = y?.numberValue {
                order = x < y
            } else {
                order = (x?.text ?? "").localizedStandardCompare(y?.text ?? "") == .orderedAscending
            }
            return ascending ? order : !order
        }
    }

    var body: some View {
        if table.rows.isEmpty {
            Text("No rows.").font(.footnote).foregroundStyle(PsycheColor.muted)
        } else {
            let shown = expanded ? rows : Array(rows.prefix(Self.shownRows))
            VStack(alignment: .leading, spacing: 8) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 18, verticalSpacing: 0) {
                        GridRow {
                            ForEach(table.columns) { column in header(column) }
                        }
                        Divider().gridCellUnsizedAxes(.horizontal)
                        ForEach(Array(shown.enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(Array(table.columns.enumerated()), id: \.offset) { index, column in
                                    cell(row[column.key], column: column, first: index == 0)
                                }
                            }
                            .padding(.vertical, 7)
                            Divider().gridCellUnsizedAxes(.horizontal).overlay(PsycheColor.hairline)
                        }
                    }
                    .padding(.trailing, 4)
                }
                .scrollBounceBehavior(.basedOnSize)
                .accessibilityLabel(table.label)
                if table.rows.count > Self.shownRows {
                    Button(expanded ? "Show fewer" : "Show all \(table.rows.count) rows") { expanded.toggle() }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(PsycheColor.inkText)
                        .frame(minHeight: 44, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder private func header(_ column: WidgetTableColumn) -> some View {
        let active = sortKey == column.key
        let label = HStack(spacing: 3) {
            Text(column.label).font(.footnote.weight(.medium)).foregroundStyle(PsycheColor.muted)
            if table.sortable {
                Image(systemName: active ? (ascending ? "chevron.up" : "chevron.down") : "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold)).foregroundStyle(PsycheColor.muted.opacity(active ? 1 : 0.5))
            }
        }
        .padding(.vertical, 7)
        if table.sortable {
            Button {
                if active { ascending.toggle() } else { sortKey = column.key; ascending = true }
            } label: { label }
            .buttonStyle(.plain)
            .gridColumnAlignment(column.kind == .number ? .trailing : .leading)
            .accessibilityLabel("Sort by \(column.label)")
            .accessibilityValue(active ? (ascending ? "ascending" : "descending") : "")
        } else {
            label.gridColumnAlignment(column.kind == .number ? .trailing : .leading)
        }
    }

    @ViewBuilder private func cell(_ value: JSONValue?, column: WidgetTableColumn, first: Bool) -> some View {
        let text: String = {
            guard let value else { return "" }
            if case .null = value { return "" }
            if column.kind == .number, let number = value.numberValue { return number.formatted() }
            if case .bool(let flag) = value { return flag ? "Yes" : "No" }
            return value.text
        }()
        if column.kind == .link, let url = WidgetLink.safeURL(text) {
            Link(text, destination: url).font(.subheadline).foregroundStyle(PsycheColor.inkText)
        } else {
            Text(text)
                .font(.subheadline.weight(first ? .medium : .regular))
                .monospacedDigit()
                .foregroundStyle(PsycheColor.text)
                .lineLimit(1)
        }
    }
}

// MARK: Chart

/// Swift Charts in the ink rule: one accent, then gray steps. Series differ by dash and marker as
/// well as by tone, so color is never the only signal; "Show data" reveals the same numbers.
struct ChartNodeView: View {
    let chart: ChartNode
    @State private var showData = false

    private static let shapes: [BasicChartSymbolShape] = [.circle, .square, .triangle, .diamond]
    private static let dashes: [[CGFloat]] = [[], [6, 3], [2, 3], [8, 3, 2, 3]]

    private var colors: [Color] {
        [PsycheColor.ink, PsycheColor.muted, PsycheColor.muted.opacity(0.6), PsycheColor.muted.opacity(0.35)]
    }

    private var pointCount: Int { chart.series.map(\.points.count).max() ?? 0 }

    private var summary: String {
        let ys = chart.series.flatMap(\.points).map(\.y)
        guard let low = ys.min(), let high = ys.max() else { return chart.label }
        let first = chart.series.first?.points.first?.x ?? ""
        let last = chart.series.first?.points.last?.x ?? ""
        let unit = chart.unit.map { " \($0)" } ?? ""
        return "\(chart.label), \(chart.kind.rawValue) chart, \(chart.series.count) series, \(pointCount) points from \(first) to \(last), from \(low.formatted(.number.notation(.compactName))) to \(high.formatted(.number.notation(.compactName)))\(unit)"
    }

    var body: some View {
        if chart.series.isEmpty || pointCount == 0 {
            EmptyView()
        } else if chart.kind == .sparkline {
            sparkline
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(chart.label).font(.subheadline.weight(.medium)).foregroundStyle(PsycheColor.text)
                    if let unit = chart.unit {
                        Text(unit).font(.footnote).foregroundStyle(PsycheColor.muted)
                    }
                }
                plot.frame(height: 170)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(summary)
                if chart.series.count > 1 { legend }
                Button(showData ? "Hide data" : "Show data") { showData.toggle() }
                    .font(.footnote.weight(.medium)).foregroundStyle(PsycheColor.inkText)
                    .frame(minHeight: 36, alignment: .leading)
                if showData { dataTable }
            }
        }
    }

    // Split out of `plot` so the type checker handles each mark on its own (CI's compiler timed out
    // on the combined builder).
    @ChartContentBuilder
    private func mark(series: String, x: String, y: Double, dash: [CGFloat]) -> some ChartContent {
        if chart.kind == .bar {
            barMark(series: series, x: x, y: y)
        } else {
            lineMark(series: series, x: x, y: y, dash: dash)
        }
    }

    private func barMark(series: String, x: String, y: Double) -> some ChartContent {
        BarMark(x: .value("Point", x), y: .value(series, y), width: .automatic)
            .position(by: .value("Series", series))
            .foregroundStyle(by: .value("Series", series))
            .cornerRadius(2)
    }

    private func lineMark(series: String, x: String, y: Double, dash: [CGFloat]) -> some ChartContent {
        let style = StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round, dash: dash)
        return LineMark(x: .value("Point", x), y: .value(series, y), series: .value("Series", series))
            .foregroundStyle(by: .value("Series", series))
            .lineStyle(style)
            .symbol(by: .value("Series", series))
            .interpolationMethod(.monotone)
    }

    private var plot: some View {
        let names = chart.series.map(\.name)
        return Chart {
            ForEach(Array(chart.series.enumerated()), id: \.offset) { index, series in
                ForEach(Array(series.points.enumerated()), id: \.offset) { _, point in
                    mark(series: series.name, x: point.x, y: point.y, dash: Self.dashes[min(index, 3)])
                }
            }
        }
        .chartForegroundStyleScale(domain: names, range: Array(colors.prefix(names.count)))
        .chartSymbolScale(domain: names, range: Array(Self.shapes.prefix(names.count)))
        .chartLegend(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine().foregroundStyle(PsycheColor.hairline)
                AxisValueLabel {
                    if let number = value.as(Double.self) {
                        Text(number.formatted(.number.notation(.compactName))).font(.caption2).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks { _ in
                AxisValueLabel().font(.caption2).foregroundStyle(PsycheColor.muted)
            }
        }
    }

    private var legend: some View {
        WidgetFlowLayout(spacing: 14) {
            ForEach(Array(chart.series.enumerated()), id: \.offset) { index, series in
                HStack(spacing: 6) {
                    if chart.kind == .bar {
                        RoundedRectangle(cornerRadius: 2).fill(colors[min(index, 3)]).frame(width: 10, height: 10)
                    } else {
                        Canvas { context, size in
                            var line = Path()
                            line.move(to: CGPoint(x: 0, y: size.height / 2))
                            line.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                            context.stroke(line, with: .color(colors[min(index, 3)]), style: StrokeStyle(lineWidth: 2, dash: Self.dashes[min(index, 3)]))
                        }
                        .frame(width: 20, height: 10)
                    }
                    Text(series.name).font(.footnote).foregroundStyle(PsycheColor.muted)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityHidden(true)
    }

    private var dataTable: some View {
        Grid(alignment: .trailing, horizontalSpacing: 16, verticalSpacing: 4) {
            GridRow {
                Text("Point").gridColumnAlignment(.leading)
                ForEach(chart.series) { Text($0.name) }
            }
            .font(.footnote.weight(.medium)).foregroundStyle(PsycheColor.muted)
            ForEach(0..<pointCount, id: \.self) { index in
                GridRow {
                    Text(chart.series.first?.points[safe: index]?.x ?? "").gridColumnAlignment(.leading)
                    ForEach(chart.series) { series in
                        Text(series.points[safe: index].map { $0.y.formatted() } ?? "")
                    }
                }
                .font(.footnote).monospacedDigit().foregroundStyle(PsycheColor.text)
            }
        }
    }

    private var sparkline: some View {
        let series = chart.series[0]
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(chart.label).font(.footnote).foregroundStyle(PsycheColor.muted)
                if let last = series.points.last {
                    Text(last.y.formatted(.number.notation(.compactName))).font(.title3.weight(.semibold)).monospacedDigit()
                        .foregroundStyle(PsycheColor.text)
                }
            }
            Chart {
                ForEach(Array(series.points.enumerated()), id: \.offset) { _, point in
                    LineMark(x: .value("Point", point.x), y: .value(series.name, point.y))
                        .foregroundStyle(PsycheColor.ink)
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.monotone)
                }
            }
            .chartXAxis(.hidden).chartYAxis(.hidden)
            .chartYScale(domain: .automatic(includesZero: false))
            .frame(height: 44)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary)
    }
}

extension Array {
    fileprivate subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

// MARK: Code

struct CodeNodeView: View {
    let code: CodeNode

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code.code)
                .font(.psycheMono(.footnote))
                .foregroundStyle(PsycheColor.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: true)
                .padding(12)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(PsycheColor.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityLabel(code.language.map { "Code, \($0)" } ?? "Code")
    }
}

// MARK: Map

struct MapNodeView: View {
    let map: MapNode

    private var located: [(place: MapPlace, coordinate: CLLocationCoordinate2D)] {
        map.places.compactMap { place in
            guard let latitude = place.latitude, let longitude = place.longitude else { return nil }
            return (place, CLLocationCoordinate2D(latitude: latitude, longitude: longitude))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !located.isEmpty {
                Map(initialPosition: .rect(Self.rect(for: located.map(\.coordinate))), interactionModes: []) {
                    ForEach(Array(located.enumerated()), id: \.offset) { _, item in
                        Marker(item.place.name, coordinate: item.coordinate).tint(PsycheColor.ink)
                    }
                }
                .mapStyle(.standard(pointsOfInterest: .excludingAll))
                .frame(height: 170)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(PsycheColor.hairline, lineWidth: 1))
                .padding(.bottom, 8)
                .accessibilityHidden(true)
            }
            ForEach(Array(map.places.enumerated()), id: \.offset) { index, place in
                if index > 0 { HairlineDivider() }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(place.name).font(.subheadline).foregroundStyle(PsycheColor.text)
                        if let address = place.address {
                            Text(address).font(.footnote).foregroundStyle(PsycheColor.muted)
                        }
                    }
                    Spacer(minLength: 8)
                    if let url = Self.mapsURL(place) {
                        Link("Open in Maps", destination: url).font(.footnote.weight(.medium)).foregroundStyle(PsycheColor.inkText)
                    }
                }
                .padding(.vertical, 9)
                .frame(minHeight: 44)
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(map.label)
    }

    static func mapsURL(_ place: MapPlace) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        var items = [URLQueryItem(name: "q", value: [place.name, place.address ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))]
        if let latitude = place.latitude, let longitude = place.longitude {
            items.append(URLQueryItem(name: "ll", value: "\(latitude),\(longitude)"))
        }
        components?.queryItems = items
        return components?.url
    }

    static func rect(for coordinates: [CLLocationCoordinate2D]) -> MKMapRect {
        let points = coordinates.map(MKMapPoint.init)
        let rect = points.dropFirst().reduce(MKMapRect(origin: points[0], size: MKMapSize(width: 0, height: 0))) {
            $0.union(MKMapRect(origin: $1, size: MKMapSize(width: 0, height: 0)))
        }
        // Pad so markers aren't on the edge; a single place gets a neighborhood-sized window.
        let minimum = 4000.0 * MKMapPointsPerMeterAtLatitude(coordinates[0].latitude)
        let width = max(rect.size.width * 1.6, minimum)
        let height = max(rect.size.height * 1.6, minimum * 0.6)
        return MKMapRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
    }
}

// MARK: Image

struct ImageNodeView: View {
    let image: ImageNode
    @Environment(\.widgetRuntime) private var runtime
    @State private var phase = Phase.idle
    @State private var loaded: PlatformImage?

    private enum Phase { case idle, loading, failed }

    var body: some View {
        Group {
            switch image.source {
            case .data(let data)?:
                if let decoded = PlatformImage(data: data) { picture(decoded) } else { note("Image unavailable: \(image.alt)") }
            case .file(let id)?:
                loadable(ref: id, requiresTap: false)
            case .remote(let url)?:
                loadable(ref: url, requiresTap: runtime?.isUntrusted ?? true)
            case nil:
                EmptyView()
            }
        }
    }

    @ViewBuilder private func loadable(ref: String, requiresTap: Bool) -> some View {
        if let loaded {
            picture(loaded)
        } else if phase == .failed {
            note("The image couldn't be loaded: \(image.alt)")
        } else if phase == .loading {
            note("Loading image: \(image.alt)").overlay(alignment: .trailing) { ProgressView().controlSize(.small).padding(.trailing, 12) }
        } else if requiresTap {
            // An untrusted widget can't fetch on its own: a remote image can be a tracking beacon.
            Button { Task { await load(ref) } } label: {
                note("Load image from an untrusted source: \(image.alt)", dashed: true)
            }
            .buttonStyle(.plain)
        } else {
            note("Loading image: \(image.alt)").task { await load(ref) }
        }
    }

    private func load(_ ref: String) async {
        guard let runtime else { phase = .failed; return }
        phase = .loading
        do {
            if let data = try await runtime.backend.image(widgetID: runtime.widgetID, ref: ref), let decoded = PlatformImage(data: data) {
                loaded = decoded
            } else {
                phase = .failed
            }
        } catch {
            phase = .failed
        }
    }

    private func picture(_ platform: PlatformImage) -> some View {
        Image(platformImage: platform)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(PsycheColor.hairline, lineWidth: 1))
            .accessibilityLabel(image.alt)
            .accessibilityAddTraits(.isImage)
    }

    private func note(_ text: String, dashed: Bool = true) -> some View {
        Text(text)
            .font(.footnote).foregroundStyle(PsycheColor.muted)
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(PsycheColor.rule, style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : []))
            )
    }
}

#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
extension Image {
    init(platformImage: PlatformImage) { self.init(uiImage: platformImage) }
}
#elseif canImport(AppKit)
import AppKit
typealias PlatformImage = NSImage
extension Image {
    init(platformImage: PlatformImage) { self.init(nsImage: platformImage) }
}
#endif
