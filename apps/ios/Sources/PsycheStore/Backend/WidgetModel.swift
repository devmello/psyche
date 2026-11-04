import Foundation

// The generative-UI widget model (docs/design/generative-ui-2026.md, docs/design/ios-app-2026.md A7).
// A widget spec is data: a tree of nodes from a fixed catalogue (`WIDGET_NODE_SCHEMAS` in
// packages/protocol/src/schemas/widgets.ts). On the wire `root` is an open JSON object, so this
// file decodes it by hand and tolerantly, like the desktop renderer's `str/arr/num` helpers:
// an unknown node type becomes `.unsupported`, an unknown field is ignored, a wrongly typed field
// falls back to its default. Decoding a spec never throws because of its nodes.

// MARK: JSON

/// A JSON value. `WidgetSpec.root` and form values travel as this.
public enum JSONValue: Sendable, Equatable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .null
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// Parse JSON text; nil when it isn't valid JSON.
    public init?(json: String) {
        guard let data = json.data(using: .utf8),
            let value = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return nil }
        self = value
    }

    public var stringValue: String? { if case .string(let value) = self { value } else { nil } }
    public var numberValue: Double? {
        if case .number(let value) = self, value.isFinite { value } else { nil }
    }
    public var boolValue: Bool? { if case .bool(let value) = self { value } else { nil } }
    public var arrayValue: [JSONValue]? { if case .array(let value) = self { value } else { nil } }
    public var objectValue: [String: JSONValue]? { if case .object(let value) = self { value } else { nil } }

    public subscript(key: String) -> JSONValue? { objectValue?[key] }

    /// Text as the desktop renderer reads it: a string, or a number written out, else empty.
    public var text: String {
        switch self {
        case .string(let value): value
        case .number(let value): Self.format(value)
        default: ""
        }
    }

    /// A number the way the wire writes it: 5, not 5.0.
    public static func format(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }
}

// MARK: Vocabulary

public enum WidgetTone: String, Sendable, Equatable, CaseIterable {
    case neutral, info, success, warning, danger

    init(_ value: JSONValue?) { self = value?.stringValue.flatMap(Self.init(rawValue:)) ?? .neutral }

    /// The spoken word that pairs with the tone's icon, so color is never the only signal.
    public var spokenName: String? {
        switch self {
        case .neutral: nil
        case .info: "Info"
        case .success: "Success"
        case .warning: "Warning"
        case .danger: "Problem"
        }
    }
}

public enum WidgetItemState: String, Sendable, Equatable, CaseIterable {
    case todo, active, done, skipped, failed

    init(_ value: JSONValue?) { self = value?.stringValue.flatMap(Self.init(rawValue:)) ?? .todo }

    public var spokenName: String {
        switch self {
        case .todo: "To do"
        case .active: "In progress"
        case .done: "Done"
        case .skipped: "Skipped"
        case .failed: "Failed"
        }
    }
}

public enum WidgetGap: String, Sendable, Equatable {
    case none, xs, sm, md, lg

    init(_ value: JSONValue?, default fallback: WidgetGap) {
        self = value?.stringValue.flatMap(Self.init(rawValue:)) ?? fallback
    }

    public var points: CGFloat {
        switch self {
        case .none: 0
        case .xs: 4
        case .sm: 8
        case .md: 12
        case .lg: 16
        }
    }
}

/// A live binding (§5.4): the node's props come from a task, automation, research, tool call or job.
public struct WidgetBind: Sendable, Equatable {
    public var source: String
    public var id: String
    public var field: String
}

/// What a control does when tapped (§6). The renderer, not the spec, decides how.
public enum WidgetAction: Sendable, Equatable {
    case reply(text: String)
    case answer(inputRequestID: String, values: [String])
    case open(route: String?, artifactID: String?, fileID: String?, url: String?)
    case tool(name: String, args: [String: JSONValue])

    init?(_ value: JSONValue?) {
        guard let value, let kind = value["kind"]?.stringValue else { return nil }
        switch kind {
        case "reply":
            self = .reply(text: value["text"]?.text ?? "")
        case "answer":
            let raw = value["value"]
            let values = raw?.arrayValue?.map(\.text) ?? raw.map { [$0.text] } ?? []
            self = .answer(inputRequestID: value["inputRequestId"]?.text ?? "", values: values)
        case "open":
            self = .open(
                route: value["route"]?.stringValue, artifactID: value["artifactId"]?.stringValue,
                fileID: value["fileId"]?.stringValue, url: value["url"]?.stringValue)
        case "tool":
            self = .tool(name: value["tool"]?.text ?? "", args: value["args"]?.objectValue ?? [:])
        default:
            return nil
        }
    }

    public var isTool: Bool { if case .tool = self { true } else { false } }
}

public struct NodeMeta: Sendable, Equatable {
    public var id: String
    public var fallbackText: String?
    public var bind: WidgetBind?
}

// MARK: Node payloads

public struct StackNode: Sendable, Equatable {
    public var horizontal: Bool
    public var gap: WidgetGap
    public var children: [WidgetNode]
}

public struct GridNode: Sendable, Equatable {
    public var columns: Int
    public var gap: WidgetGap
    public var children: [WidgetNode]
}

public struct TabNode: Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var children: [WidgetNode]
}

public struct CardNode: Sendable, Equatable {
    public var title: String?
    public var subtitle: String?
    public var tone: WidgetTone
    public var children: [WidgetNode]
}

public struct ListRow: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var meta: String?
    public var action: WidgetAction?
}

public struct ProgressStep: Sendable, Equatable {
    public var label: String
    public var state: WidgetItemState
}

public struct ProgressNode: Sendable, Equatable {
    public var label: String
    public var value: Double?
    public var max: Double
    public var indeterminate: Bool
    public var steps: [ProgressStep]
    public var tone: WidgetTone

    /// 0...1, or nil while indeterminate.
    public var fraction: Double? {
        guard !indeterminate, let value else { return nil }
        return Swift.max(0, Swift.min(1, value / max))
    }
}

public struct ChecklistItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var state: WidgetItemState
    public var detail: String?
}

public struct TimelineEntry: Sendable, Equatable, Identifiable {
    public var id: String
    public var time: String?
    public var label: String
    public var tone: WidgetTone
}

public struct StatNode: Sendable, Equatable {
    public var label: String
    /// Numbers stay numbers so the view can group digits for the locale.
    public var number: Double?
    public var text: String
    public var unit: String?
    public var delta: String?
    public var tone: WidgetTone
}

public struct KVRow: Sendable, Equatable {
    public var label: String
    public var value: String
}

public struct WidgetTableColumn: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case text, number, date, link }
    public var key: String
    public var label: String
    public var kind: Kind
    public var id: String { key }
}

public struct TableNode: Sendable, Equatable {
    public var label: String
    public var columns: [WidgetTableColumn]
    public var rows: [[String: JSONValue]]
    public var sortable: Bool
}

public struct ChartPoint: Sendable, Equatable {
    public var x: String
    public var y: Double
}

public struct ChartSeries: Sendable, Equatable, Identifiable {
    public var name: String
    public var points: [ChartPoint]
    public var id: String { name }
}

public struct ChartNode: Sendable, Equatable {
    public enum Kind: String, Sendable { case bar, line, sparkline }
    public var label: String
    public var kind: Kind
    public var unit: String?
    public var series: [ChartSeries]
}

public struct TextNode: Sendable, Equatable {
    public var text: String
    public var strong: Bool
    public var tone: WidgetTone
}

public struct CodeNode: Sendable, Equatable {
    public var code: String
    public var language: String?

    public init(code: String, language: String? = nil) {
        self.code = code
        self.language = language
    }
}

public struct ImageNode: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        case file(id: String)
        case data(Data)
        case remote(url: String)
    }
    public var alt: String
    public var source: Source?
}

public struct MapPlace: Sendable, Equatable {
    public var name: String
    public var address: String?
    public var latitude: Double?
    public var longitude: Double?
}

public struct MapNode: Sendable, Equatable {
    public var label: String
    public var places: [MapPlace]
}

public struct ButtonNode: Sendable, Equatable {
    public var label: String
    public var action: WidgetAction?
    public var tone: WidgetTone
}

public struct ChoiceOption: Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
}

public struct ChoicesNode: Sendable, Equatable {
    public var label: String
    public var multiple: Bool
    public var options: [ChoiceOption]
    public var ask: Bool
    public var action: WidgetAction?
}

public struct FormField: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case text, textarea, number, select, toggle, date }
    public var id: String
    public var label: String
    public var kind: Kind
    public var required: Bool
    public var options: [ChoiceOption]
    public var placeholder: String?
}

public struct FormNode: Sendable, Equatable {
    public enum Submit: String, Sendable { case reply, tool }
    public var label: String
    public var fields: [FormField]
    public var submitLabel: String
    public var submit: Submit?
    public var tool: String?
    public var template: String?
}

// MARK: The node

/// One catalogue node. Unknown types are `.unsupported`; nothing here can fail to decode.
public indirect enum WidgetNode: Sendable, Equatable, Identifiable {
    case stack(NodeMeta, StackNode)
    case grid(NodeMeta, GridNode)
    case tabs(NodeMeta, [TabNode])
    case card(NodeMeta, CardNode)
    case list(NodeMeta, [ListRow])
    case progress(NodeMeta, ProgressNode)
    case checklist(NodeMeta, [ChecklistItem])
    case timeline(NodeMeta, [TimelineEntry])
    case status(NodeMeta, label: String, tone: WidgetTone)
    case stat(NodeMeta, StatNode)
    case kv(NodeMeta, [KVRow])
    case table(NodeMeta, TableNode)
    case chart(NodeMeta, ChartNode)
    case text(NodeMeta, TextNode)
    case markdown(NodeMeta, String)
    case code(NodeMeta, CodeNode)
    case image(NodeMeta, ImageNode)
    case map(NodeMeta, MapNode)
    case link(NodeMeta, label: String, url: String)
    case button(NodeMeta, ButtonNode)
    case choices(NodeMeta, ChoicesNode)
    case form(NodeMeta, FormNode)
    /// A type this build doesn't know (a newer catalogue): drawn as "Open on your Mac".
    case unsupported(NodeMeta, type: String)

    public var meta: NodeMeta {
        switch self {
        case .stack(let m, _), .grid(let m, _), .tabs(let m, _), .card(let m, _), .list(let m, _),
            .progress(let m, _), .checklist(let m, _), .timeline(let m, _), .status(let m, _, _),
            .stat(let m, _), .kv(let m, _), .table(let m, _), .chart(let m, _), .text(let m, _),
            .markdown(let m, _), .code(let m, _), .image(let m, _), .map(let m, _), .link(let m, _, _),
            .button(let m, _), .choices(let m, _), .form(let m, _), .unsupported(let m, _):
            m
        }
    }

    /// Node ids are unique inside a spec; a missing id falls back to a stable placeholder.
    public var id: String { meta.id }

    /// The type name on the wire (`"stack"`, `"chart"`, or whatever an unknown node said).
    public var typeName: String {
        switch self {
        case .stack: "stack"
        case .grid: "grid"
        case .tabs: "tabs"
        case .card: "card"
        case .list: "list"
        case .progress: "progress"
        case .checklist: "checklist"
        case .timeline: "timeline"
        case .status: "status"
        case .stat: "stat"
        case .kv: "kv"
        case .table: "table"
        case .chart: "chart"
        case .text: "text"
        case .markdown: "markdown"
        case .code: "code"
        case .image: "image"
        case .map: "map"
        case .link: "link"
        case .button: "button"
        case .choices: "choices"
        case .form: "form"
        case .unsupported(_, let type): type
        }
    }

    /// The 21 types of the catalogue this build renders.
    public static let supportedTypes: [String] = [
        "stack", "grid", "tabs", "card", "list", "progress", "checklist", "timeline", "status", "stat",
        "kv", "table", "chart", "text", "markdown", "code", "image", "map", "link", "button", "choices",
        "form",
    ]

    /// The deepest nesting drawn; the Gateway caps at 8, the client doesn't trust that.
    public static let maxDepth = 10

    /// Parse a node from its wire JSON. Never fails.
    public init(json: JSONValue, depth: Int = 0) {
        let meta = NodeMeta(
            id: json["id"]?.text ?? "", fallbackText: json["fallbackText"]?.stringValue,
            bind: Self.bind(json["bind"]))
        let type = json["type"]?.stringValue ?? ""
        guard depth <= Self.maxDepth else {
            self = .unsupported(meta, type: type)
            return
        }
        func children(_ value: JSONValue?) -> [WidgetNode] {
            (value?.arrayValue ?? []).filter { $0.objectValue != nil }.map { WidgetNode(json: $0, depth: depth + 1) }
        }
        func objects(_ value: JSONValue?) -> [JSONValue] { (value?.arrayValue ?? []).filter { $0.objectValue != nil } }
        func options(_ value: JSONValue?) -> [ChoiceOption] {
            objects(value).map { ChoiceOption(id: $0["id"]?.text ?? "", label: $0["label"]?.text ?? "") }
        }

        switch type {
        case "stack":
            self = .stack(meta, StackNode(
                horizontal: json["direction"]?.stringValue == "horizontal",
                gap: WidgetGap(json["gap"], default: .sm), children: children(json["children"])))
        case "grid":
            self = .grid(meta, GridNode(
                columns: min(4, max(2, Int(json["columns"]?.numberValue ?? 2))),
                gap: WidgetGap(json["gap"], default: .md), children: children(json["children"])))
        case "tabs":
            self = .tabs(meta, objects(json["tabs"]).map {
                TabNode(id: $0["id"]?.text ?? "", label: $0["label"]?.text ?? "", children: children($0["children"]))
            })
        case "card":
            self = .card(meta, CardNode(
                title: json["title"]?.stringValue.nonEmpty, subtitle: json["subtitle"]?.stringValue.nonEmpty,
                tone: WidgetTone(json["tone"]), children: children(json["children"])))
        case "list":
            self = .list(meta, objects(json["items"]).map {
                ListRow(
                    id: $0["id"]?.text ?? "", title: $0["title"]?.text ?? "", meta: $0["meta"]?.stringValue.nonEmpty,
                    action: WidgetAction($0["action"]))
            })
        case "progress":
            self = .progress(meta, ProgressNode(
                label: json["label"]?.text ?? "", value: json["value"]?.numberValue,
                max: json["max"]?.numberValue.flatMap { $0 > 0 ? $0 : nil } ?? 100,
                indeterminate: json["indeterminate"]?.boolValue == true || json["value"]?.numberValue == nil,
                steps: objects(json["steps"]).map {
                    ProgressStep(label: $0["label"]?.text ?? "", state: WidgetItemState($0["state"]))
                },
                tone: WidgetTone(json["tone"])))
        case "checklist":
            self = .checklist(meta, objects(json["items"]).enumerated().map { index, item in
                ChecklistItem(
                    id: item["id"]?.stringValue ?? "item\(index)", label: item["label"]?.text ?? "",
                    state: WidgetItemState(item["state"]), detail: item["detail"]?.stringValue.nonEmpty)
            })
        case "timeline":
            self = .timeline(meta, objects(json["entries"]).enumerated().map { index, entry in
                TimelineEntry(
                    id: entry["id"]?.stringValue ?? "entry\(index)", time: entry["time"]?.stringValue.nonEmpty,
                    label: entry["label"]?.text ?? "", tone: WidgetTone(entry["tone"]))
            })
        case "status":
            self = .status(meta, label: json["label"]?.text ?? "", tone: WidgetTone(json["tone"]))
        case "stat":
            self = .stat(meta, StatNode(
                label: json["label"]?.text ?? "", number: json["value"]?.numberValue, text: json["value"]?.text ?? "",
                unit: json["unit"]?.stringValue.nonEmpty, delta: json["delta"]?.stringValue.nonEmpty,
                tone: WidgetTone(json["tone"])))
        case "kv":
            self = .kv(meta, objects(json["rows"]).map { KVRow(label: $0["label"]?.text ?? "", value: $0["value"]?.text ?? "") })
        case "table":
            self = .table(meta, TableNode(
                label: json["label"]?.text ?? "",
                columns: objects(json["columns"]).map {
                    WidgetTableColumn(
                        key: $0["key"]?.text ?? "", label: $0["label"]?.text ?? "",
                        kind: $0["type"]?.stringValue.flatMap(WidgetTableColumn.Kind.init(rawValue:)) ?? .text)
                },
                rows: objects(json["rows"]).compactMap(\.objectValue), sortable: json["sortable"]?.boolValue == true))
        case "chart":
            self = .chart(meta, ChartNode(
                label: json["label"]?.text ?? "",
                kind: json["kind"]?.stringValue.flatMap(ChartNode.Kind.init(rawValue:)) ?? .bar,
                unit: json["unit"]?.stringValue.nonEmpty,
                series: objects(json["series"]).prefix(4).map { series in
                    ChartSeries(
                        name: series["name"]?.text ?? "",
                        points: objects(series["points"]).prefix(365).map {
                            ChartPoint(x: $0["x"]?.text ?? "", y: $0["y"]?.numberValue ?? 0)
                        })
                }))
        case "text":
            self = .text(meta, TextNode(
                text: json["text"]?.text ?? "", strong: json["emphasis"]?.stringValue == "strong",
                tone: WidgetTone(json["tone"])))
        case "markdown":
            self = .markdown(meta, json["md"]?.text ?? "")
        case "code":
            self = .code(meta, CodeNode(code: json["code"]?.text ?? "", language: json["language"]?.stringValue.nonEmpty))
        case "image":
            self = .image(meta, ImageNode(alt: json["alt"]?.text ?? "", source: Self.imageSource(json["src"])))
        case "map":
            self = .map(meta, MapNode(
                label: json["label"]?.text ?? "",
                places: objects(json["places"]).map {
                    MapPlace(
                        name: $0["name"]?.text ?? "", address: $0["address"]?.stringValue.nonEmpty,
                        latitude: $0["lat"]?.numberValue, longitude: $0["lng"]?.numberValue)
                }))
        case "link":
            self = .link(meta, label: json["label"]?.text ?? "", url: json["url"]?.text ?? "")
        case "button":
            self = .button(meta, ButtonNode(
                label: json["label"]?.text ?? "", action: WidgetAction(json["action"]), tone: WidgetTone(json["tone"])))
        case "choices":
            self = .choices(meta, ChoicesNode(
                label: json["label"]?.text ?? "", multiple: json["mode"]?.stringValue == "multi",
                options: options(json["options"]), ask: json["ask"]?.boolValue == true,
                action: WidgetAction(json["action"])))
        case "form":
            let submit = json["submit"]
            self = .form(meta, FormNode(
                label: json["label"]?.text ?? "",
                fields: objects(json["fields"]).map {
                    FormField(
                        id: $0["id"]?.text ?? "", label: $0["label"]?.text ?? "",
                        kind: $0["type"]?.stringValue.flatMap(FormField.Kind.init(rawValue:)) ?? .text,
                        required: $0["required"]?.boolValue == true, options: options($0["options"]),
                        placeholder: $0["placeholder"]?.stringValue.nonEmpty)
                },
                submitLabel: submit?["label"]?.text ?? "", submit: submit?["as"]?.stringValue.flatMap(FormNode.Submit.init(rawValue:)),
                tool: submit?["tool"]?.stringValue, template: submit?["template"]?.stringValue))
        default:
            self = .unsupported(meta, type: type)
        }
    }

    private static func bind(_ value: JSONValue?) -> WidgetBind? {
        guard let source = value?["source"]?.stringValue, let id = value?["id"]?.stringValue,
            let field = value?["field"]?.stringValue
        else { return nil }
        return WidgetBind(source: source, id: id, field: field)
    }

    private static func imageSource(_ value: JSONValue?) -> ImageNode.Source? {
        if let dataURL = value?["dataUrl"]?.stringValue {
            // data:image/(png|jpeg|gif|webp);base64,<payload>
            guard dataURL.hasPrefix("data:image/"), let comma = dataURL.firstIndex(of: ","),
                dataURL[..<comma].hasSuffix(";base64"),
                let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
            else { return nil }
            return .data(data)
        }
        if let fileID = value?["fileId"]?.stringValue { return .file(id: fileID) }
        if let url = value?["url"]?.stringValue, url.hasPrefix("https://") { return .remote(url: url) }
        return nil
    }
}

extension Optional where Wrapped == String {
    fileprivate var nonEmpty: String? { self.flatMap { $0.isEmpty ? nil : $0 } }
}

// MARK: Spec and snapshot

/// The wire spec: `{ v, title, fallbackText, root }` with `root` kept as raw JSON so bindings can be
/// merged before it is parsed.
public struct WidgetSpec: Sendable, Equatable, Codable {
    public var v: Int
    public var title: String
    public var fallbackText: String
    public var root: JSONValue

    public init(v: Int = 1, title: String, fallbackText: String, root: JSONValue) {
        self.v = v
        self.title = title
        self.fallbackText = fallbackText
        self.root = root
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        v = (try? container.decode(Int.self, forKey: .v)) ?? 1
        title = (try? container.decode(String.self, forKey: .title)) ?? ""
        fallbackText = (try? container.decode(String.self, forKey: .fallbackText)) ?? ""
        root = (try? container.decode(JSONValue.self, forKey: .root)) ?? .null
    }

    private enum Keys: String, CodingKey { case v, title, fallbackText, root }

    /// Decode a spec from JSON text. Only a spec that isn't JSON at all fails.
    public init(json: String) throws {
        guard let data = json.data(using: .utf8) else { throw BackendError.notFound }
        self = try JSONDecoder().decode(WidgetSpec.self, from: data)
    }

    /// The node tree, with live bindings merged over the nodes they name (§5.4).
    public func node(applying bindings: [String: [String: JSONValue]] = [:]) -> WidgetNode {
        WidgetNode(json: Self.merge(root, bindings))
    }

    private static func merge(_ json: JSONValue, _ bindings: [String: [String: JSONValue]]) -> JSONValue {
        guard var object = json.objectValue else { return json }
        if let id = object["id"]?.stringValue, let props = bindings[id] {
            for (key, value) in props { object[key] = value }
        }
        for key in ["children"] {
            if let list = object[key]?.arrayValue { object[key] = .array(list.map { merge($0, bindings) }) }
        }
        if let tabs = object["tabs"]?.arrayValue {
            object["tabs"] = .array(tabs.map { tab in
                guard var tab = tab.objectValue else { return tab }
                if let list = tab["children"]?.arrayValue { tab["children"] = .array(list.map { merge($0, bindings) }) }
                return .object(tab)
            })
        }
        return .object(object)
    }
}

/// A widget as the screen draws it: the spec, where it came from and whether it still moves.
public struct WidgetSnapshot: Sendable, Equatable, Identifiable {
    public var id: String
    public var rev: Int
    public var spec: WidgetSpec
    /// Resolved props for bound nodes, keyed by node id (empty for a static widget).
    public var bindings: [String: [String: JSONValue]]
    /// Live widgets keep updating; frozen ones are a record.
    public var isLive: Bool
    /// Origins or senders of untrusted content the widget was built from (empty when trusted).
    public var untrustedSources: [String]
    public var pinned: Bool
    public var updatedAt: Date

    public init(
        id: String, rev: Int = 1, spec: WidgetSpec, bindings: [String: [String: JSONValue]] = [:],
        isLive: Bool = true, untrustedSources: [String] = [], pinned: Bool = false, updatedAt: Date = Date()
    ) {
        self.id = id
        self.rev = rev
        self.spec = spec
        self.bindings = bindings
        self.isLive = isLive
        self.untrustedSources = untrustedSources
        self.pinned = pinned
        self.updatedAt = updatedAt
    }

    public var title: String { spec.title }
    public var isUntrusted: Bool { !untrustedSources.isEmpty }
    public var root: WidgetNode { spec.node(applying: bindings) }
}
