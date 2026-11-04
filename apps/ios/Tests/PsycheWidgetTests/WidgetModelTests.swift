import Foundation
import Testing

@testable import PsycheStore

/// Every node of a tree, depth first.
private func walk(_ node: WidgetNode) -> [WidgetNode] {
    let kids: [WidgetNode]
    switch node {
    case .stack(_, let n): kids = n.children
    case .grid(_, let n): kids = n.children
    case .card(_, let n): kids = n.children
    case .tabs(_, let tabs): kids = tabs.flatMap(\.children)
    default: kids = []
    }
    return [node] + kids.flatMap(walk)
}

struct WidgetModelTests {
    @Test func everyFixtureDecodes() throws {
        for fixture in WidgetFixture.all {
            let spec = try WidgetSpec(json: fixture.specJSON)
            #expect(!spec.title.isEmpty, "\(fixture.id) has a title")
            #expect(!spec.fallbackText.isEmpty, "\(fixture.id) has fallback text")
            let root = fixture.snapshot.root
            if fixture.id != "wdg_unknown" {
                for node in walk(root) {
                    if case .unsupported(_, let type) = node { Issue.record("\(fixture.id): \(type) came out unsupported") }
                }
            }
        }
    }

    @Test func fixturesCoverTheWholeCatalogue() {
        let seen = Set(WidgetFixture.all.flatMap { walk($0.snapshot.root) }.map(\.typeName))
        for type in WidgetNode.supportedTypes { #expect(seen.contains(type), "no fixture draws \(type)") }
    }

    @Test func unknownTypesAndFieldsDoNotFail() throws {
        let root = WidgetFixture.unknown.snapshot.root
        let nodes = walk(root)
        let unsupported = nodes.compactMap { node -> String? in
            if case .unsupported(_, let type) = node { type } else { nil }
        }
        #expect(unsupported == ["heatmap", "gauge", "quantum"])
        // Known siblings and the nested known card are unaffected by unknown fields.
        let texts = nodes.compactMap { node -> String? in if case .text(_, let t) = node { t.text } else { nil } }
        #expect(texts == ["This text still shows."])
        if case .unsupported(let meta, "heatmap")? = nodes.first(where: { $0.id == "hm" }) {
            #expect(meta.fallbackText == "Busiest on Thursday.")
        } else {
            Issue.record("heatmap should be unsupported with its fallback text")
        }
        #expect(WidgetFixture.unknown.spec.title == "From a newer Psyche")
    }

    @Test func wronglyTypedFieldsFallBackToDefaults() {
        let json = JSONValue(json: #"{"id":"p","type":"progress","label":5,"value":"x","max":-3,"steps":"no","tone":"loud"}"#)!
        guard case .progress(_, let progress) = WidgetNode(json: json) else { Issue.record("not a progress node"); return }
        #expect(progress.label == "5")
        #expect(progress.indeterminate)
        #expect(progress.max == 100)
        #expect(progress.steps.isEmpty)
        #expect(progress.tone == .neutral)
        #expect(progress.fraction == nil)
    }

    @Test func notAnObjectAndMissingTypeAreUnsupported() {
        #expect(WidgetNode(json: .string("hi")).typeName == "")
        #expect(WidgetNode(json: .object(["id": .string("x")])).typeName == "")
        let spec = try? WidgetSpec(json: #"{"v":1,"title":"t","fallbackText":"f"}"#)
        #expect(spec?.node().typeName == "")
    }

    @Test func nestingDeeperThanTheCapIsCutOff() {
        var json: JSONValue = .object(["id": .string("leaf"), "type": .string("text"), "text": .string("deep")])
        for level in 0..<20 {
            json = .object(["id": .string("s\(level)"), "type": .string("stack"), "children": .array([json])])
        }
        let leaf = walk(WidgetNode(json: json)).last
        #expect(leaf?.typeName == "stack", "the tree stops at the depth cap instead of recursing forever")
        #expect(walk(WidgetNode(json: json)).count == WidgetNode.maxDepth + 2)
    }

    @Test func gridColumnsAreClampedAndUnsafeImageSourcesDropped() {
        let grid = WidgetNode(json: JSONValue(json: #"{"id":"g","type":"grid","columns":9,"children":[]}"#)!)
        if case .grid(_, let g) = grid { #expect(g.columns == 4) } else { Issue.record("not a grid") }
        for src in [#"{"url":"http://insecure.example/a.png"}"#, #"{"dataUrl":"data:text/html;base64,AAAA"}"#, #"{}"#] {
            let image = WidgetNode(json: JSONValue(json: #"{"id":"i","type":"image","alt":"a","src":\#(src)}"#)!)
            if case .image(_, let node) = image { #expect(node.source == nil, "\(src)") } else { Issue.record("not an image") }
        }
        let data = WidgetFixture.imageData.snapshot.root
        if case .image(_, let node) = data, case .data(let bytes)? = node.source { #expect(bytes.count > 100) } else { Issue.record("data image") }
    }

    @Test func actionsParseAndBadOnesAreDropped() {
        #expect(WidgetAction(JSONValue(json: #"{"kind":"reply","text":"hi"}"#)) == .reply(text: "hi"))
        #expect(WidgetAction(JSONValue(json: #"{"kind":"answer","inputRequestId":"ir_1","value":["a","b"]}"#)) == .answer(inputRequestID: "ir_1", values: ["a", "b"]))
        #expect(WidgetAction(JSONValue(json: #"{"kind":"answer","inputRequestId":"ir_1","value":"a"}"#)) == .answer(inputRequestID: "ir_1", values: ["a"]))
        #expect(WidgetAction(JSONValue(json: #"{"kind":"tool","tool":"t","args":{"k":1}}"#)) == .tool(name: "t", args: ["k": .number(1)]))
        #expect(WidgetAction(JSONValue(json: #"{"kind":"teleport"}"#)) == nil)
        #expect(WidgetAction(nil) == nil)
    }

    @Test func bindingsMergeOverBoundNodes() {
        let widget = WidgetFixture.bound.snapshot
        let nodes = walk(widget.root)
        guard case .progress(_, let progress)? = nodes.first(where: { $0.id == "p" }) else { Issue.record("no progress"); return }
        #expect(progress.fraction == 1.0 / 3.0)
        #expect(!progress.indeterminate)
        guard case .checklist(_, let items)? = nodes.first(where: { $0.id == "steps" }) else { Issue.record("no checklist"); return }
        #expect(items.map(\.state) == [.done, .active, .todo])
        // Without bindings the spec's own props show: indeterminate progress, an empty checklist.
        var bare = widget
        bare.bindings = [:]
        guard case .progress(_, let unbound)? = walk(bare.root).first(where: { $0.id == "p" }) else { Issue.record("no progress"); return }
        #expect(unbound.indeterminate)
        #expect(widget.root.find(id: "adv")?.typeName == "button")
    }

    @Test func snapshotCarriesTrustAndLiveness() {
        #expect(!WidgetFixture.progress.snapshot.isUntrusted)
        #expect(WidgetFixture.tainted.snapshot.isUntrusted)
        #expect(!WidgetFixture.frozen.snapshot.isLive)
    }
}

struct WidgetBackendTests {
    let store = FixtureBackend()

    @Test func unknownWidgetIsNotFound() async {
        await #expect(throws: BackendError.notFound) { try await store.widget(id: "wdg_nope") }
    }

    @Test func aReplyChangesTheWidgetAndPublishesAnEvent() async throws {
        let events = store.events()
        var iterator = events.makeAsyncIterator()
        try await Task.sleep(for: .milliseconds(30))  // the stream registers asynchronously
        let before = try await store.widget(id: "wdg_interactive")
        #expect(before.root.find(id: "last_action") == nil)

        let after = try await store.act(
            widgetID: "wdg_interactive", nodeID: "go", itemID: nil, action: .reply(text: "Draft the replies now"), values: [:])
        let updated = try #require(after)
        #expect(updated.rev == before.rev + 1)
        guard case .status(_, let label, let tone)? = updated.root.find(id: "last_action") else {
            Issue.record("the action should leave a status line"); return
        }
        #expect(label.contains("Draft the replies now"))
        #expect(tone == .success)
        // The change persists: a fresh read sees it, and the sent log records it.
        #expect(try await store.widget(id: "wdg_interactive").root.find(id: "last_action") != nil)
        #expect(await store.sentWidgetActions().map(\.nodeID) == ["go"])
        #expect(await iterator.next() == .changed(.home))

        // Acting again updates the line instead of stacking another.
        _ = try await store.act(widgetID: "wdg_interactive", nodeID: "go", itemID: nil, action: .reply(text: "Again"), values: [:])
        let children = walk(try await store.widget(id: "wdg_interactive").root).filter { $0.id == "last_action" }
        #expect(children.count == 1)
    }

    @Test func aRequiredFormFieldIsRefusedWithAMessage() async throws {
        await #expect(throws: BackendError.refused("Name is required.")) {
            _ = try await store.act(
                widgetID: "wdg_interactive", nodeID: "note", itemID: nil, action: .reply(text: "Note"), values: ["msg": .string("hi")])
        }
        let ok = try await store.act(
            widgetID: "wdg_interactive", nodeID: "note", itemID: nil, action: .reply(text: "Note"), values: ["name": .string("Sam")])
        #expect(ok != nil)
    }

    @Test func aBadEmailAddressIsRefused() async {
        await #expect(throws: BackendError.refused("“nobody” doesn't look like an email address.")) {
            _ = try await store.act(
                widgetID: "wdg_interactive", nodeID: "toolform", itemID: nil, action: .tool(name: "send_email", args: [:]),
                values: ["to": .string("nobody")])
        }
    }

    @Test func aFrozenWidgetRefusesActions() async {
        await #expect(throws: BackendError.refused("This widget is frozen.")) {
            _ = try await store.act(widgetID: "wdg_frozen", nodeID: "x", itemID: nil, action: .reply(text: "hi"), values: [:])
        }
    }

    @Test func aToolActionMovesTheBoundTaskForward() async throws {
        let before = try await store.widget(id: "wdg_bound")
        let after = try #require(
            try await store.act(widgetID: "wdg_bound", nodeID: "adv", itemID: nil, action: .tool(name: "advance_booking", args: [:]), values: [:]))
        guard case .progress(_, let a)? = before.root.find(id: "p"), case .progress(_, let b)? = after.root.find(id: "p") else {
            Issue.record("no progress node"); return
        }
        #expect((b.fraction ?? 0) > (a.fraction ?? 0))
    }

    @Test func openActionsLeaveTheWidgetAlone() async throws {
        let result = try await store.act(
            widgetID: "wdg_interactive", nodeID: "rows", itemID: "r1",
            action: .open(route: "/scheduled", artifactID: nil, fileID: nil, url: nil), values: [:])
        #expect(result == nil)
    }

    @Test func imagesComeBackAsRealPNGBytes() async throws {
        let data = try #require(try await store.image(widgetID: "wdg_img_remote", ref: "https://img.example/photo.png"))
        #expect(data.starts(with: [0x89, 0x50, 0x4E, 0x47]))
    }
}
