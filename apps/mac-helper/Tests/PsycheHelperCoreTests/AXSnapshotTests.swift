import CoreGraphics
import PsycheHelperCore
import Testing

/// In-memory accessibility tree for builder tests.
final class FakeTree: AXTreeSource {
    struct Node {
        var info: AXElementInfo
        var children: [Int] = []
        var visibleRows: [Int] = []
        var header: Int?
        var actions: [String] = []
        var settable = false
    }

    var nodes: [Int: Node] = [:]
    private var nextId = 1

    @discardableResult
    func add(_ info: AXElementInfo, parent: Int? = nil, actions: [String] = [], settable: Bool = false) -> Int {
        let id = nextId
        nextId += 1
        nodes[id] = Node(info: info, actions: actions, settable: settable)
        if let parent { nodes[parent]?.children.append(id) }
        return id
    }

    func info(_ e: Int) -> AXElementInfo? { nodes[e]?.info }
    func children(_ e: Int) -> [Int] { nodes[e]?.children ?? [] }
    func visibleRows(_ e: Int) -> [Int] { nodes[e]?.visibleRows ?? [] }
    func header(_ e: Int) -> Int? { nodes[e]?.header }
    func actions(_ e: Int) -> [String] { nodes[e]?.actions ?? [] }
    func isValueSettable(_ e: Int) -> Bool { nodes[e]?.settable ?? false }
}

private func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }

/// A Notes-like window: sidebar table with visible rows, a note body, a toolbar, a scroll bar.
private func notesWindow() -> (FakeTree, window: Int, body: Int, rows: [Int], offscreenRow: Int) {
    let t = FakeTree()
    let w = t.add(AXElementInfo(role: "AXWindow", subrole: "AXStandardWindow", title: "Notes", frame: rect(0, 0, 1000, 600)), actions: ["AXRaise"])
    let split = t.add(AXElementInfo(role: "AXSplitGroup", frame: rect(0, 50, 1000, 550)), parent: w)
    let scroll = t.add(AXElementInfo(role: "AXScrollArea", frame: rect(0, 50, 200, 550)), parent: split)
    let table = t.add(AXElementInfo(role: "AXTable", description: "Notes list", frame: rect(0, 50, 200, 2000)), parent: scroll)
    var rows: [Int] = []
    for i in 0..<3 {
        let row = t.add(AXElementInfo(role: "AXRow", selected: i == 0, frame: rect(0, 50 + Double(i) * 60, 200, 60)), parent: table,
                        actions: ["Name:pin\nTarget:0x0\nSelector:(null)", "Name:trash\nTarget:0x0\nSelector:(null)"])
        let cell = t.add(AXElementInfo(role: "AXCell", frame: rect(0, 50 + Double(i) * 60, 200, 60)), parent: row)
        t.add(AXElementInfo(role: "AXStaticText", value: "Note \(i)", frame: rect(5, 55 + Double(i) * 60, 100, 20)), parent: cell)
        rows.append(row)
    }
    // A row far below the fold: in AXChildren but not in AXVisibleRows.
    let off = t.add(AXElementInfo(role: "AXRow", frame: rect(0, 1900, 200, 60)), parent: table)
    t.add(AXElementInfo(role: "AXStaticText", value: "Old note", frame: rect(5, 1905, 100, 20)), parent: off)
    t.nodes[table]?.visibleRows = rows
    t.add(AXElementInfo(role: "AXScrollBar", frame: rect(190, 50, 10, 550)), parent: scroll)
    let body = t.add(AXElementInfo(role: "AXTextArea", value: "Groceries\nmilk", frame: rect(200, 50, 800, 550)), parent: split, settable: true)
    let toolbar = t.add(AXElementInfo(role: "AXToolbar", frame: rect(0, 0, 1000, 50)), parent: w)
    t.add(AXElementInfo(role: "AXButton", description: "New Note", frame: rect(500, 5, 40, 40)), parent: toolbar, actions: ["AXPress", "AXScrollToVisible"])
    t.add(AXElementInfo(role: "AXButton", subrole: "AXCloseButton", frame: rect(5, 5, 16, 16)), parent: w, actions: ["AXPress"])
    return (t, w, body, rows, off)
}

@Suite("AX snapshot builder")
struct AXSnapshotTests {
    @Test func notesWindowIsPrunedAndLabelled() {
        let (t, w, body, _, _) = notesWindow()
        let refs = AXRefTable<Int>()
        let snap = AXSnapshotBuilder(source: t, refs: refs, options: AXSnapshotOptions(), focused: body)
            .snapshot(root: w, app: "Notes", pid: 812, bundleId: "com.apple.Notes", electron: false)
        let text = snap.render()
        #expect(text.hasPrefix("# app=Notes pid=812 window=\"Notes\" @0,0 1000x600 focus="))
        #expect(!text.contains("scrollbar"))
        #expect(!text.contains("splitgroup") && !text.contains("scrollarea"))  // hoisted containers
        #expect(!text.contains("Old note"))  // only AXVisibleRows are walked
        let row = snap.nodes.first { $0.role == "row" }
        #expect(row?.label == "Note 0" && row?.flags.contains("selected") == true)
        #expect(row?.actions == ["custom:pin", "custom:trash"])
        #expect(!snap.nodes.contains { $0.role == "text" && $0.label == "Note 0" })  // collapsed into the row
        let area = snap.nodes.first { $0.role == "textarea" }
        #expect(area?.value == "Groceries⏎milk" && area?.actions == ["set"] && area?.flags == ["focused"])
        #expect(snap.nodes.contains { $0.role == "button" && $0.label == "New Note" && $0.actions == ["press"] })
        #expect(snap.nodes.contains { $0.role == "button:closeButton" })
        #expect(snap.header.focused == area?.ref)
        #expect(snap.header.truncated == nil)
    }

    @Test func refsAreStableAcrossSnapshotsAndNeverReassigned() {
        let (t, w, body, rows, _) = notesWindow()
        let refs = AXRefTable<Int>()
        let first = AXSnapshotBuilder(source: t, refs: refs, options: AXSnapshotOptions(), focused: body)
            .snapshot(root: w, app: "Notes", pid: 1, bundleId: nil, electron: false)
        // Delete a row and add a new one: the survivors keep their refs; the newcomer gets a new ref.
        t.nodes[rows[0]] = nil
        t.nodes[w]?.children.removeAll { $0 == rows[0] }
        let table = t.nodes.first { $0.value.info.role == "AXTable" }!.key
        let newRow = t.add(AXElementInfo(role: "AXRow", description: "New", frame: rect(0, 50, 200, 60)), parent: table)
        t.nodes[table]?.visibleRows = [newRow, rows[1], rows[2]]
        let second = AXSnapshotBuilder(source: t, refs: refs, options: AXSnapshotOptions(), focused: body)
            .snapshot(root: w, app: "Notes", pid: 1, bundleId: nil, electron: false)
        let firstRefs = Dictionary(uniqueKeysWithValues: first.nodes.map { ($0.ref, $0.label ?? $0.role) })
        for n in second.nodes where firstRefs[n.ref] != nil {
            #expect(firstRefs[n.ref] == (n.label ?? n.role))
        }
        let fresh = second.nodes.first { $0.label == "New" }
        #expect(fresh != nil && firstRefs[fresh!.ref] == nil)
        #expect(second.header.snapGen == first.header.snapGen + 1 && second.header.newRefs == 1)
    }

    @Test func secureFieldsAreRedactedAndNotDescended() {
        let t = FakeTree()
        let w = t.add(AXElementInfo(role: "AXWindow", title: "Login", frame: rect(0, 0, 400, 300)))
        let pw = t.add(AXElementInfo(role: "AXTextField", subrole: "AXSecureTextField", description: "Password", value: "hunter2", frame: rect(10, 10, 200, 20)), parent: w, settable: true)
        t.add(AXElementInfo(role: "AXStaticText", value: "hunter2", frame: rect(10, 10, 200, 20)), parent: pw)
        let snap = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: AXSnapshotOptions(), focused: nil)
            .snapshot(root: w, app: "X", pid: 1, bundleId: nil, electron: false)
        #expect(!snap.render().contains("hunter2"))
        let field = snap.nodes.first { $0.role == "textfield:secureTextField" }
        #expect(field?.value == "•••" && field?.flags.contains("secure") == true && field?.actions.contains("set") == false)
    }

    @Test func offWindowElementsAreClippedExceptMenus() {
        let t = FakeTree()
        let w = t.add(AXElementInfo(role: "AXWindow", title: "W", frame: rect(0, 0, 100, 100)))
        t.add(AXElementInfo(role: "AXButton", title: "Inside", frame: rect(10, 10, 20, 20)), parent: w, actions: ["AXPress"])
        t.add(AXElementInfo(role: "AXButton", title: "Outside", frame: rect(500, 500, 20, 20)), parent: w, actions: ["AXPress"])
        t.add(AXElementInfo(role: "AXMenuItem", title: "Menu item", frame: rect(900, 900, 20, 20)), parent: w, actions: ["AXPress"])
        let snap = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: AXSnapshotOptions(), focused: nil)
            .snapshot(root: w, app: "X", pid: 1, bundleId: nil, electron: false)
        let labels = snap.nodes.compactMap(\.label)
        #expect(labels.contains("Inside") && !labels.contains("Outside") && labels.contains("Menu item"))
    }

    @Test func deepElectronContentSurvivesBecauseDepthIsNotTheBudget() {
        // Chromium web content starts deep; a depth-8 cap would lose it (spike 04).
        let t = FakeTree()
        let w = t.add(AXElementInfo(role: "AXWindow", title: "App", frame: rect(0, 0, 800, 600)))
        var parent = w
        for _ in 0..<14 { parent = t.add(AXElementInfo(role: "AXGroup", frame: rect(0, 0, 800, 600)), parent: parent) }
        let web = t.add(AXElementInfo(role: "AXWebArea", title: "Form", url: "file:///form.html", frame: rect(0, 0, 800, 600)), parent: parent)
        t.add(AXElementInfo(role: "AXTextField", description: "Email", placeholder: "you@example.com", frame: rect(10, 10, 200, 20)), parent: web, settable: true)
        let snap = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: AXSnapshotOptions(), focused: nil)
            .snapshot(root: w, app: "Form", pid: 1, bundleId: nil, electron: true)
        let field = snap.nodes.first { $0.label == "Email" }
        #expect(field?.placeholder == "you@example.com" && field?.actions == ["set"])
        #expect(snap.nodes.contains { $0.role == "webarea" && $0.url == "file:///form.html" })
        #expect(snap.render().contains(" electron "))
    }

    @Test func budgetsTruncateVisibly() {
        let t = FakeTree()
        let w = t.add(AXElementInfo(role: "AXWindow", title: "W", frame: rect(0, 0, 1000, 1000)))
        for i in 0..<50 { t.add(AXElementInfo(role: "AXButton", title: "B\(i)", frame: rect(1, 1, 10, 10)), parent: w, actions: ["AXPress"]) }
        var o = AXSnapshotOptions()
        o.maxEmit = 10
        let snap = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: o, focused: nil)
            .snapshot(root: w, app: "X", pid: 1, bundleId: nil, electron: false)
        #expect(snap.nodes.count == 10 && snap.header.truncated == "maxEmit")
        #expect(snap.render().contains("TRUNCATED(maxEmit)"))
        o = AXSnapshotOptions()
        o.maxVisit = 5
        let visitCapped = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: o, focused: nil)
            .snapshot(root: w, app: "X", pid: 1, bundleId: nil, electron: false)
        #expect(visitCapped.header.truncated == "maxVisit")
    }

    @Test func unreachableFocusedElementIsAppendedAsDetached() {
        let (t, w, _, _, _) = notesWindow()
        let editor = t.add(AXElementInfo(role: "AXTextField", value: "draft.txt", identifier: "ShrinkToFit Text Field", frame: rect(300, 300, 100, 16)), settable: true)
        let snap = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: AXSnapshotOptions(), focused: editor)
            .snapshot(root: w, app: "Finder", pid: 1, bundleId: nil, electron: false)
        let last = snap.nodes.last
        #expect(last?.value == "draft.txt" && last?.flags == ["focused", "detached"])
        #expect(snap.header.focused == last?.ref)
    }

    @Test func checkboxValuesAndLongLabels() {
        let t = FakeTree()
        let w = t.add(AXElementInfo(role: "AXWindow", title: "W", frame: rect(0, 0, 1000, 1000)))
        t.add(AXElementInfo(role: "AXCheckBox", title: "Remember", value: "1", frame: rect(1, 1, 10, 10)), parent: w, actions: ["AXPress"])
        t.add(AXElementInfo(role: "AXButton", title: String(repeating: "x", count: 100), frame: rect(1, 20, 10, 10)), parent: w, actions: ["AXPress"])
        let snap = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: AXSnapshotOptions(), focused: nil)
            .snapshot(root: w, app: "X", pid: 1, bundleId: nil, electron: false)
        #expect(snap.nodes.first { $0.role == "checkbox" }?.value == "on")
        #expect(snap.nodes.first { $0.role == "button" }?.label?.hasSuffix("…(+20)") == true)
    }

    @Test func refTableEvictsRefsUnseenForTooLong() {
        let refs = AXRefTable<Int>(evictAfterSnapshots: 2)
        _ = refs.beginSnapshot()
        let (r, _) = refs.ref(for: 42)
        for _ in 0..<3 { _ = refs.beginSnapshot() }
        #expect(refs.element(for: r) == nil)
        let (again, isNew) = refs.ref(for: 42)
        #expect(isNew && again != r)  // never reassigned: a new ref is minted
    }

    @Test func selectorsMustMatchExactlyOne() {
        let nodes = [
            AXSnapshotNode(ref: "e1", role: "button", label: "Add Reminder", actions: ["press"], flags: [], depth: 0),
            AXSnapshotNode(ref: "e2", role: "button", label: "Add List: Groceries", actions: ["press"], flags: [], depth: 0),
            AXSnapshotNode(ref: "e3", role: "button", label: "Add Reminder", actions: ["press"], flags: [], depth: 1),
        ]
        #expect(AXSelector(role: "button", label: "Add List: Groceries").resolve(in: nodes) == .ref("e2"))
        #expect(AXSelector(role: "button", label: "Add").resolve(in: nodes) == .none)  // no substring matching
        #expect(AXSelector(role: "button", label: "Add Reminder").resolve(in: nodes) == .ambiguous(["e1", "e3"]))
    }

    @Test func expectationsCatchReusedViews() {
        let e = AXExpectation(role: "button", label: "Add Reminder")
        #expect(e.mismatch(role: "button", label: "Add Reminder", value: nil) == nil)
        #expect(e.mismatch(role: "button", label: "Add Item", value: nil) != nil)
        #expect(e.mismatch(role: "row", label: "Add Reminder", value: nil) != nil)
        let truncated = AXExpectation(role: "textarea", label: "Groceries · milk…(+40)", valuePrefix: "Groc")
        #expect(truncated.mismatch(role: "textarea", label: "Groceries · milk, eggs and more", value: "Groceries") == nil)
        #expect(truncated.mismatch(role: "textarea", label: "Groceries · milk, eggs", value: "Taxes") != nil)
    }
}

@Suite("AX snapshot hardening")
struct AXSnapshotHardeningTests {
    @Test func collapsedLabelsNeverIncludeSecureValues() {
        let t = FakeTree()
        let w = t.add(AXElementInfo(role: "AXWindow", title: "W", frame: CGRect(x: 0, y: 0, width: 500, height: 500)))
        let row = t.add(AXElementInfo(role: "AXButton", frame: CGRect(x: 0, y: 0, width: 100, height: 20)), parent: w, actions: ["AXPress"])
        t.add(AXElementInfo(role: "AXTextField", subrole: "AXSecureTextField", value: "hunter2", frame: CGRect(x: 0, y: 0, width: 50, height: 20)), parent: row)
        t.add(AXElementInfo(role: "AXStaticText", value: "Sign in", frame: CGRect(x: 50, y: 0, width: 50, height: 20)), parent: row)
        let b = AXSnapshotBuilder(source: t, refs: AXRefTable<Int>(), options: AXSnapshotOptions(), focused: nil)
        let snap = b.snapshot(root: w, app: "X", pid: 1, bundleId: nil, electron: false)
        #expect(!snap.render().contains("hunter2"))
        #expect(b.label(for: row) == "Sign in")
    }

    @Test func optionsAreClamped() {
        let o = AXSnapshotOptions.clamped(maxVisit: -5, maxEmit: 1_000_000, textMax: -1, valueMax: 0, clip: false)
        #expect(o.maxVisit == 50 && o.maxEmit == 2_000 && o.textMax == 20 && o.valueMax == 20 && !o.clip)
        #expect(AXText.truncate("abc", -1) == "a…(+2)")
    }
}
