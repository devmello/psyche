// axsnap — spike-04 throwaway: Accessibility-tree snapshots and ref-based actions for an LLM.
// Not production code. See docs/spikes/spike-04-ax-snapshot.md for findings.
import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

// MARK: - Options

struct Opts: Codable {
    var maxDepth = 40          // raw AX depth below the window
    var maxVisit = 6000        // AX elements fetched (IPC budget)
    var maxEmit = 400          // lines emitted
    var textMax = 80           // label truncation
    var valueMax = 160         // value truncation
    var clip = true            // drop elements outside window / scroll-area clip rect
    var prune = true           // hoist children of unlabelled containers
    var menubar = false        // also walk the app menu bar
    var json = false
    var timeout: Float = 1.0   // AXUIElementSetMessagingTimeout per app
    var window: Int? = nil     // AXWindows index instead of focused window
    var manualAX = true        // set AXManualAccessibility on Electron apps
    var appRoot = false        // walk the application element (all windows, menus) instead of one window
}

// MARK: - CF helpers

func cfStr(_ v: CFTypeRef?) -> String? {
    guard let v else { return nil }
    let t = CFGetTypeID(v)
    if t == CFStringGetTypeID() { return (v as! String) }
    if t == CFAttributedStringGetTypeID() { return (v as! NSAttributedString).string }
    if t == CFNumberGetTypeID() { return (v as! NSNumber).stringValue }
    if t == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) ? "true" : "false" }
    if t == CFURLGetTypeID() { return (v as! URL).absoluteString }
    return nil
}

func isAXError(_ v: CFTypeRef?) -> Bool {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return false }
    return AXValueGetType(v as! AXValue) == .axError
}

func cfBool(_ v: CFTypeRef?) -> Bool? {
    guard let v, !isAXError(v) else { return nil }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    if CFGetTypeID(v) == CFNumberGetTypeID() { return (v as! NSNumber).boolValue }
    return nil
}

func cfPoint(_ v: CFTypeRef?) -> CGPoint? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func cfSize(_ v: CFTypeRef?) -> CGSize? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func cfElements(_ v: CFTypeRef?) -> [AXUIElement] {
    guard let v, CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
    return (v as! [AnyObject]).compactMap { o in
        CFGetTypeID(o) == AXUIElementGetTypeID() ? (o as! AXUIElement) : nil
    }
}

var axCalls = 0

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    axCalls += 1
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func attrs(_ e: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
    axCalls += 1
    var out: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(e, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
          let arr = out as? [AnyObject] else { return [:] }
    var d: [String: CFTypeRef] = [:]
    for (i, n) in names.enumerated() where i < arr.count {
        let v = arr[i] as CFTypeRef
        if !isAXError(v) { d[n] = v }
    }
    return d
}

func actionNames(_ e: AXUIElement) -> [String] {
    axCalls += 1
    var a: CFArray?
    guard AXUIElementCopyActionNames(e, &a) == .success, let arr = a as? [String] else { return [] }
    return arr
}

func settable(_ e: AXUIElement, _ name: String) -> Bool {
    axCalls += 1
    var b: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(e, name as CFString, &b) == .success && b.boolValue
}

func trunc(_ s: String?, _ n: Int) -> String? {
    guard var s else { return nil }
    s = s.replacingOccurrences(of: "\n", with: "⏎").replacingOccurrences(of: "\t", with: " ")
        .trimmingCharacters(in: .whitespaces)
    if s.isEmpty { return nil }
    if s.count <= n { return s }
    return String(s.prefix(n)) + "…(+\(s.count - n))"
}

// MARK: - Element identity (session-stable refs)

struct ElKey: Hashable {
    let e: AXUIElement
    func hash(into h: inout Hasher) { h.combine(CFHash(e)) }
    static func == (a: ElKey, b: ElKey) -> Bool { CFEqual(a.e, b.e) }
}

final class Session {
    var refOf: [ElKey: String] = [:]
    var elOf: [String: AXUIElement] = [:]
    var next = 1
    func ref(for e: AXUIElement) -> (String, Bool) {
        let k = ElKey(e: e)
        if let r = refOf[k] { return (r, false) }
        let r = "e\(next)"; next += 1
        refOf[k] = r; elOf[r] = e
        return (r, true)
    }
}

// MARK: - Snapshot

struct Node: Codable {
    var ref: String
    var role: String
    var label: String?
    var value: String?
    var placeholder: String?
    var url: String?
    var id: String?
    var flags: [String]
    var frame: [Int]?
    var actions: [String]
    var depth: Int
    var parent: String?
}

struct Header: Codable {
    var app: String
    var pid: Int32
    var bundle: String?
    var electron: Bool
    var window: String?
    var windowFrame: [Int]?
    var focused: String?
    var visited: Int
    var emitted: Int
    var prunedContainers: Int
    var prunedOffscreen: Int
    var truncated: String?
    var axCalls: Int
    var ms: Double
    var newRefs: Int
    var reusedRefs: Int
}

let BASE_ATTRS = ["AXRole", "AXSubrole", "AXTitle", "AXValue", "AXDescription", "AXHelp",
                  "AXPlaceholderValue", "AXIdentifier", "AXEnabled", "AXFocused", "AXSelected",
                  "AXPosition", "AXSize", "AXURL", "AXTitleUIElement"]

// Containers that carry no meaning of their own unless labelled.
let CONTAINER_ROLES: Set = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem",
                            "AXUnknown", "AXSplitter", "AXMatte", "AXRuler", "AXGrowArea", "AXColumn",
                            "AXScrollBar", "AXValueIndicator", "AXBrowser", "AXGenericElement"]
// Structural landmarks we always keep (gives the model orientation).
let LANDMARK_ROLES: Set = ["AXWindow", "AXSheet", "AXDialog", "AXToolbar", "AXTable", "AXOutline", "AXList",
                           "AXTabGroup", "AXWebArea", "AXMenuBar", "AXMenu", "AXPopover", "AXDrawer"]
let INTERACTIVE_ROLES: Set = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
                              "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXSlider", "AXIncrementor",
                              "AXLink", "AXRow", "AXCell", "AXMenuItem", "AXMenuBarItem", "AXDisclosureTriangle",
                              "AXColorWell", "AXDateField", "AXTimeField", "AXSegmentedControl", "AXStepper",
                              "AXDockItem", "AXRadioGroup", "AXSearchField", "AXTab"]
let TEXT_ROLES: Set = ["AXStaticText", "AXHeading", "AXImage"]
// Interactive leaves whose label usually lives in descendant text.
let COLLAPSE_ROLES: Set = ["AXButton", "AXLink", "AXRow", "AXCell", "AXMenuItem", "AXCheckBox",
                           "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab"]
let NOISE_ACTIONS: Set = ["AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"]
// VoiceOver navigation custom actions present on every toolbar item; noise for an agent.
let CUSTOM_NOISE: Set = ["Move next", "Move previous", "Remove from toolbar"]

/// Custom actions come back as "Name:pin\nTarget:0x0\nSelector:(null)"; keep the name.
func customActionName(_ raw: String) -> String {
    guard raw.hasPrefix("Name:") else { return raw }
    return String(raw.dropFirst(5).split(separator: "\n", maxSplits: 1).first ?? "")
}

let ACTION_SHORT: [String: String] = ["AXPress": "press", "AXShowMenu": "menu", "AXConfirm": "confirm",
                                      "AXCancel": "cancel", "AXRaise": "raise", "AXIncrement": "inc",
                                      "AXDecrement": "dec", "AXPick": "pick", "AXOpen": "open"]

/// Keep developer-assigned identifiers (stable anchors); drop AppKit/auto-generated ones.
func cleanId(_ id: String?) -> String? {
    guard let id, !id.isEmpty, id.count <= 40, !id.hasPrefix("_NS"), !id.hasPrefix("NS"),
          !id.contains(","), !id.contains("["), !id.contains(" ") || id.count <= 24 else { return nil }
    return id
}

func roleName(_ role: String, _ sub: String?) -> String {
    var r = role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased()
    if r == "statictext" { r = "text" }
    if let sub, !sub.isEmpty, sub != "AXUnknown" {
        let s = sub.hasPrefix("AX") ? String(sub.dropFirst(2)) : sub
        let keep: Set = ["SearchField", "SecureTextField", "CloseButton", "MinimizeButton", "ZoomButton",
                         "FullScreenButton", "Toggle", "Switch", "TabButton", "OutlineRow", "SortButton",
                         "TextLink", "Dialog", "StandardWindow", "FloatingWindow", "SystemDialog"]
        if keep.contains(s) { r += ":" + s.prefix(1).lowercased() + s.dropFirst() }
    }
    return r
}

final class Snapshotter {
    let o: Opts
    let session: Session
    var nodes: [Node] = []
    var visited = 0, prunedContainers = 0, prunedOffscreen = 0
    var truncated: String?
    var newRefs = 0, reused = 0
    var seen = Set<ElKey>()
    var focusEl: AXUIElement?

    init(_ o: Opts, _ s: Session) { self.o = o; self.session = s }

    func gatherText(_ e: AXUIElement, _ depth: Int, _ out: inout [String]) {
        if depth > 4 || out.count >= 6 { return }
        for c in cfElements(attr(e, "AXChildren")) {
            visited += 1
            let a = attrs(c, ["AXRole", "AXValue", "AXTitle", "AXDescription"])
            let role = cfStr(a["AXRole"]) ?? ""
            if role == "AXStaticText" || role == "AXTextField" || role == "AXHeading" {
                if let t = cfStr(a["AXValue"]) ?? cfStr(a["AXTitle"]), !t.trimmingCharacters(in: .whitespaces).isEmpty { out.append(t) }
            } else if role == "AXImage", let d = cfStr(a["AXDescription"]), !d.isEmpty {
                out.append(d)
            }
            gatherText(c, depth + 1, &out)
        }
    }

    func walk(_ e: AXUIElement, depth: Int, kept: Int, parent: String?, clip: CGRect, inCollapsed: Bool,
              parentLabel: String? = nil, parentActs: Set<String> = [], parentValue: String? = nil,
              inheritSelected: Bool = false) {
        if visited >= o.maxVisit { truncated = truncated ?? "maxVisit"; return }
        if nodes.count >= o.maxEmit { truncated = truncated ?? "maxEmit"; return }
        if !seen.insert(ElKey(e: e)).inserted { return }   // tables expose cells via rows *and* columns
        visited += 1
        let a = attrs(e, BASE_ATTRS)
        let role = cfStr(a["AXRole"]) ?? "AXUnknown"
        let sub = cfStr(a["AXSubrole"])
        // Scroll bars and table columns only duplicate what rows / scroll actions already give.
        if o.prune && (role == "AXScrollBar" || role == "AXColumn" || role == "AXGrowArea") { prunedContainers += 1; return }
        var frame: CGRect?
        if let p = cfPoint(a["AXPosition"]), let s = cfSize(a["AXSize"]),
           [p.x, p.y, s.width, s.height].allSatisfy({ $0.isFinite && abs($0) < 1e7 }) {   // some apps report inf/NaN
            frame = CGRect(origin: p, size: s)
        }
        if o.clip, let f = frame, f.width > 0, f.height > 0, !clip.isNull, !f.intersects(clip),
           role != "AXMenu", role != "AXMenuItem", role != "AXMenuBar", role != "AXMenuBarItem" {
            prunedOffscreen += 1; return
        }
        let acts = actionNames(e).map(customActionName).filter { !NOISE_ACTIONS.contains($0) }
        let secure = sub == "AXSecureTextField"
        var label = cfStr(a["AXTitle"]).flatMap { $0.isEmpty ? nil : $0 }
            ?? cfStr(a["AXDescription"]).flatMap { $0.isEmpty ? nil : $0 }
        if label == nil, let tui = a["AXTitleUIElement"], CFGetTypeID(tui) == AXUIElementGetTypeID() {
            label = cfStr(attr(tui as! AXUIElement, "AXValue"))
        }
        var value: String? = secure ? (cfStr(a["AXValue"]).map { _ in "•••" }) : cfStr(a["AXValue"])
        if role == "AXCheckBox" || role == "AXRadioButton" { value = value.map { $0 == "1" ? "on" : ($0 == "0" ? "off" : $0) } }
        let placeholder = cfStr(a["AXPlaceholderValue"])
        let ident = cfStr(a["AXIdentifier"])
        let isTextInput = role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" || role == "AXSearchField"
        let canSet = (isTextInput || role == "AXSlider") && !secure && settable(e, "AXValue")
        let meaningfulActs = acts.filter { $0 != "AXShowMenu" }

        let labelled = label != nil || (ident != nil && !(ident!.hasPrefix("_NS")))
        var keep: Bool
        if !o.prune { keep = true }
        else if LANDMARK_ROLES.contains(role) || INTERACTIVE_ROLES.contains(role) || canSet { keep = true }
        else if !meaningfulActs.isEmpty { keep = true }              // e.g. clickable web divs
        else if TEXT_ROLES.contains(role) {
            keep = !inCollapsed && ((value?.isEmpty == false) || label != nil)
        } else if CONTAINER_ROLES.contains(role) { keep = label != nil }
        else { keep = labelled || value?.isEmpty == false }
        if o.prune && role == "AXImage" && label == nil && meaningfulActs.isEmpty { keep = false }
        if o.prune && role == "AXStaticText" && label == nil && value == nil { keep = false }
        // Zero-area, unlabelled elements are hidden chrome (collapsed scroll arrows etc.).
        if o.prune, let f = frame, f.width < 1 || f.height < 1, label == nil, value == nil { keep = false }

        var collapse = false
        if keep && COLLAPSE_ROLES.contains(role) && label == nil && (value == nil || role == "AXRow" || role == "AXCell") {
            var parts: [String] = []
            gatherText(e, 0, &parts)
            if !parts.isEmpty { label = parts.joined(separator: " · ") }
            collapse = true
        }
        if keep && COLLAPSE_ROLES.contains(role) && label != nil { collapse = true }
        // Unlabelled row/cell wrapping a single control (System Settings sidebar): hoist the control.
        var passSelected = false
        if o.prune && keep && (role == "AXRow" || role == "AXCell") && label == nil && meaningfulActs.isEmpty {
            keep = false; collapse = false
            passSelected = inheritSelected || cfBool(a["AXSelected"]) == true
        }
        // Text that only repeats its parent's value ("Memory" = "16 GB" > "16 GB").
        if o.prune && keep && role == "AXStaticText" && label == nil && value != nil && (value == parentValue || value == parentLabel) { keep = false }
        // Echo of the parent (row > cell > cell view all carrying the same text): skip, keep walking.
        if o.prune && keep && label != nil && label == parentLabel && (value == nil || value == label)
            && !canSet && Set(acts).subtracting(parentActs).subtracting(["AXShowMenu"]).isEmpty {
            keep = false
        }

        var myRef = parent
        var myKept = kept
        if keep {
            let (r, isNew) = session.ref(for: e)
            if isNew { newRefs += 1 } else { reused += 1 }
            var flags: [String] = []
            if cfBool(a["AXEnabled"]) == false { flags.append("disabled") }
            // Per-element AXFocused is unreliable (every cell of a focused table reports true);
            // compare with the app's AXFocusedUIElement instead.
            if let f = focusEl, CFEqual(f, e) { flags.append("focused") }
            if cfBool(a["AXSelected"]) == true || inheritSelected { flags.append("selected") }
            if secure { flags.append("secure") }
            var shortActs = acts.filter { $0.hasPrefix("AX") }.compactMap { ACTION_SHORT[$0] }
            let custom = acts.filter { !$0.hasPrefix("AX") && !CUSTOM_NOISE.contains($0) && !parentActs.contains($0) }
            shortActs += custom.prefix(3).map { "custom:" + (trunc($0, 24) ?? $0) }
            if custom.count > 3 { shortActs.append("+\(custom.count - 3)custom") }
            if canSet { shortActs.append("set") }
            let showValue = value != nil && value != label
            nodes.append(Node(ref: r, role: roleName(role, sub), label: trunc(label, o.textMax),
                              value: showValue ? trunc(value, o.valueMax) : nil,
                              placeholder: (value?.isEmpty ?? true) ? trunc(placeholder, 40) : nil,
                              url: role == "AXWebArea" || role == "AXLink" ? trunc(cfStr(a["AXURL"]), 120) : nil,
                              id: cleanId(ident),
                              flags: flags, frame: frame.map { [Int($0.minX), Int($0.minY), Int($0.width), Int($0.height)] },
                              actions: shortActs, depth: kept, parent: parent))
            myRef = r; myKept = kept + 1
        } else { prunedContainers += 1 }

        if depth >= o.maxDepth { if !cfElements(attr(e, "AXChildren")).isEmpty { truncated = truncated ?? "maxDepth" }; return }
        if secure { return }
        var nextClip = clip
        if (role == "AXScrollArea" || role == "AXWebArea"), let f = frame, f.width > 0 { nextClip = clip.intersection(f) }
        // Tables/outlines: walk only visible rows (AXChildren holds every row, e.g. thousands in Mail/Finder).
        var kids: [AXUIElement]
        if role == "AXTable" || role == "AXOutline" {
            kids = cfElements(attr(e, "AXVisibleRows"))
            if let hdr = attr(e, "AXHeader"), CFGetTypeID(hdr) == AXUIElementGetTypeID() { kids.insert(hdr as! AXUIElement, at: 0) }
            if kids.isEmpty { kids = cfElements(attr(e, "AXChildren")) }
        } else {
            kids = cfElements(attr(e, "AXChildren"))
        }
        for c in kids {
            walk(c, depth: depth + 1, kept: myKept, parent: myRef, clip: nextClip, inCollapsed: inCollapsed || collapse,
                 parentLabel: label ?? parentLabel, parentActs: Set(acts), parentValue: value,
                 inheritSelected: passSelected)
        }
    }
}

// MARK: - App resolution

func findApp(_ q: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications
    if let pid = Int32(q) { return NSRunningApplication(processIdentifier: pid) }
    if let a = apps.first(where: { $0.bundleIdentifier?.lowercased() == q.lowercased() }) { return a }
    if let a = apps.first(where: { $0.localizedName?.lowercased() == q.lowercased() && $0.activationPolicy == .regular }) { return a }
    return apps.first(where: { $0.localizedName?.lowercased() == q.lowercased() })
}

func isElectron(_ app: NSRunningApplication) -> Bool {
    guard let u = app.bundleURL else { return false }
    return FileManager.default.fileExists(atPath: u.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
}

func appElement(_ app: NSRunningApplication, _ o: Opts) -> AXUIElement {
    let ae = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ae, o.timeout)
    if isElectron(app) && o.manualAX {
        // Wakes Chromium's AX tree; Chrome itself uses AXEnhancedUserInterface instead.
        let r = AXUIElementSetAttributeValue(ae, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if r != .success { FileHandle.standardError.write("warn: AXManualAccessibility set -> \(r.rawValue)\n".data(using: .utf8)!) }
    }
    return ae
}

func targetWindow(_ ae: AXUIElement, _ o: Opts) -> AXUIElement? {
    if let i = o.window {
        let ws = cfElements(attr(ae, "AXWindows"))
        return i < ws.count ? ws[i] : nil
    }
    if let w = attr(ae, "AXFocusedWindow"), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
    if let w = attr(ae, "AXMainWindow"), CFGetTypeID(w) == AXUIElementGetTypeID() { return (w as! AXUIElement) }
    return cfElements(attr(ae, "AXWindows")).first
}

// MARK: - Render

func render(_ h: Header, _ nodes: [Node]) -> String {
    var s = "# app=\(h.app) pid=\(h.pid)"
    if h.electron { s += " electron" }
    if let w = h.window { s += " window=\"\(w)\"" }
    if let f = h.windowFrame { s += " @\(f[0]),\(f[1]) \(f[2])x\(f[3])" }
    if let f = h.focused { s += " focus=\(f)" }
    s += " nodes=\(h.emitted)/\(h.visited)"
    if let t = h.truncated { s += " TRUNCATED(\(t))" }
    s += "\n"
    for n in nodes {
        var l = String(repeating: "  ", count: n.depth) + "[\(n.ref)] \(n.role)"
        if let x = n.label { l += " \"\(x)\"" }
        if let x = n.value { l += " =\"\(x)\"" }
        if let x = n.placeholder { l += " ph=\"\(x)\"" }
        if let x = n.id { l += " #\(x)" }
        if let x = n.url { l += " <\(x)>" }
        if !n.actions.isEmpty { l += " {\(n.actions.joined(separator: ","))}" }
        if !n.flags.isEmpty { l += " " + n.flags.joined(separator: " ") }
        if let f = n.frame { l += " @\(f[0]),\(f[1]) \(f[2])x\(f[3])" }
        s += l + "\n"
    }
    return s
}

struct SnapResult { var header: Header; var nodes: [Node]; var text: String }

func snapshot(_ app: NSRunningApplication, _ o: Opts, _ session: Session) -> SnapResult? {
    axCalls = 0
    let t0 = DispatchTime.now()
    let ae = appElement(app, o)
    guard let win = o.appRoot ? ae : targetWindow(ae, o) else { return nil }
    let wa = attrs(win, ["AXTitle", "AXPosition", "AXSize"])
    var wf = CGRect.null
    if let p = cfPoint(wa["AXPosition"]), let s = cfSize(wa["AXSize"]) { wf = CGRect(origin: p, size: s) }
    let sn = Snapshotter(o, session)
    if let f = attr(ae, "AXFocusedUIElement"), CFGetTypeID(f) == AXUIElementGetTypeID() { sn.focusEl = (f as! AXUIElement) }
    sn.walk(win, depth: 0, kept: 0, parent: nil, clip: wf, inCollapsed: false)
    if o.menubar, let mb = attr(ae, "AXMenuBar"), CFGetTypeID(mb) == AXUIElementGetTypeID() {
        sn.walk(mb as! AXUIElement, depth: 0, kept: 0, parent: nil, clip: .null, inCollapsed: false)
    }
    // The focused element is not always reachable from the window's AXChildren (Finder's rename
    // field editor, some popovers); always include it so the model can type into it.
    if let f = sn.focusEl, !sn.seen.contains(ElKey(e: f)) {
        var co = o; co.maxDepth = 2
        let fs = Snapshotter(co, session); fs.focusEl = f; fs.seen = sn.seen
        fs.walk(f, depth: 0, kept: 0, parent: nil, clip: .null, inCollapsed: false)
        for var n in fs.nodes { n.flags.append("detached"); sn.nodes.append(n) }
        sn.visited += fs.visited
    }
    let focusRef = sn.focusEl.flatMap { session.refOf[ElKey(e: $0)] }
    let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
    let h = Header(app: app.localizedName ?? "?", pid: app.processIdentifier, bundle: app.bundleIdentifier,
                   electron: isElectron(app), window: cfStr(wa["AXTitle"]),
                   windowFrame: wf.isNull ? nil : [Int(wf.minX), Int(wf.minY), Int(wf.width), Int(wf.height)],
                   focused: focusRef, visited: sn.visited, emitted: sn.nodes.count,
                   prunedContainers: sn.prunedContainers, prunedOffscreen: sn.prunedOffscreen,
                   truncated: sn.truncated, axCalls: axCalls, ms: (ms * 10).rounded() / 10,
                   newRefs: sn.newRefs, reusedRefs: sn.reused)
    var text: String
    if o.json {
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        struct Out: Codable { var header: Header; var nodes: [Node] }
        text = String(data: try! enc.encode(Out(header: h, nodes: sn.nodes)), encoding: .utf8)! + "\n"
    } else { text = render(h, sn.nodes) }
    return SnapResult(header: h, nodes: sn.nodes, text: text)
}

// MARK: - Errors and ref resolution
//
// Refs live in a long-running server process (`axsnap serve`), keyed by AXUIElement identity
// (CFEqual), so an element keeps its ref across snapshots and a ref is never reassigned to a
// different element. A first version re-walked the tree per CLI call and matched DFS-order refs
// by role+label; after an intervening snapshot that silently pointed a ref at a different element.

struct Fail: Error { let msg: String }
func die(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(2) }

let session = Session()
var snapGen = 0

func resolve(_ ref: String) throws -> AXUIElement {
    guard let e = session.elOf[ref] else { throw Fail(msg: "unknown ref \(ref): take a snapshot first (refs are never reused)") }
    var v: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(e, "AXRole" as CFString, &v)
    if r == .invalidUIElement { throw Fail(msg: "stale ref \(ref): element no longer exists; re-snapshot") }
    if r == .cannotComplete { throw Fail(msg: "ref \(ref): app not responding") }
    return e
}

// MARK: - Actions

func center(_ e: AXUIElement) -> CGPoint? {
    let a = attrs(e, ["AXPosition", "AXSize"])
    guard let p = cfPoint(a["AXPosition"]), let s = cfSize(a["AXSize"]) else { return nil }
    return CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2)
}

func perform(_ e: AXUIElement, _ action: String) -> AXError { AXUIElementPerformAction(e, action as CFString) }

/// Write AXValue (replace) or AXSelectedText (insert at caret), refusing secure fields, checking
/// settability first (AXUIElementSetAttributeValue can return .success on elements that have no
/// such attribute) and reading the value back.
func setValue(_ e: AXUIElement, _ v: String, attr name: String = "AXValue") throws -> String {
    let a = attrs(e, ["AXSubrole", "AXRole"])
    if cfStr(a["AXSubrole"]) == "AXSecureTextField" { throw Fail(msg: "refused: secure text field") }
    guard settable(e, name) else { throw Fail(msg: "\(name) not settable on \(cfStr(a["AXRole"]) ?? "?")") }
    let before = cfStr(attr(e, "AXValue")) ?? ""
    let r = AXUIElementSetAttributeValue(e, name as CFString, v as CFString)
    if r != .success { throw Fail(msg: "set \(name) failed: AXError \(r.rawValue)") }
    // Read back with backoff: Chromium applies the write to its AX tree asynchronously (~100-300 ms).
    var after = ""
    for (i, wait) in [50_000, 100_000, 200_000, 400_000].enumerated() {
        usleep(UInt32(wait))
        after = cfStr(attr(e, "AXValue")) ?? ""
        let good = name == "AXValue" ? after == v : after.count == before.count + v.count
        if good { return "verified after \([50, 150, 350, 750][i]) ms" }
    }
    return "UNVERIFIED: read-back \(before.count)->\(after.count) chars after 750 ms"
}

func mouseClick(_ p: CGPoint, count: Int = 1, right: Bool = false) {
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
    for i in 1...count {
        let down = CGEvent(mouseEventSource: src, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: p, mouseButton: right ? .right : .left)
        let up = CGEvent(mouseEventSource: src, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: p, mouseButton: right ? .right : .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down?.post(tap: .cghidEventTap); usleep(20_000); up?.post(tap: .cghidEventTap); usleep(40_000)
    }
}

func typeText(_ s: String, pid: pid_t?) {
    let src = CGEventSource(stateID: .hidSystemState)
    let units = Array(s.utf16)
    var i = 0
    while i < units.count {
        let chunk = Array(units[i..<min(i + 16, units.count)])
        for down in [true, false] {
            let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
            ev?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            if let pid { ev?.postToPid(pid) } else { ev?.post(tap: .cghidEventTap) }
        }
        usleep(15_000)
        i += 16
    }
}

let KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
    "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "fwddelete": 117, ",": 43, ".": 47, "/": 44, "-": 27, "=": 24]

func key(_ combo: String, pid: pid_t?) throws {
    var flags = CGEventFlags()
    var k: CGKeyCode?
    for p in combo.lowercased().split(separator: "+") {
        switch p {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "opt", "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: k = KEYCODES[String(p)]
        }
    }
    guard let k else { throw Fail(msg: "unknown key in \(combo)") }
    let src = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        let ev = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: down)
        ev?.flags = flags
        if let pid { ev?.postToPid(pid) } else { ev?.post(tap: .cghidEventTap) }
        usleep(20_000)
    }
}

func scroll(at p: CGPoint, dy: Int32) {
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
    CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
}

/// Press a menu item by path ("File>New Note") without opening the menu.
func menuPress(_ app: NSRunningApplication, _ path: String) throws -> AXError {
    let ae = appElement(app, Opts())
    guard let mb = attr(ae, "AXMenuBar"), CFGetTypeID(mb) == AXUIElementGetTypeID() else { throw Fail(msg: "no menu bar") }
    var cur = mb as! AXUIElement
    for (i, name) in path.split(separator: ">").map({ $0.trimmingCharacters(in: .whitespaces) }).enumerated() {
        var items = cfElements(attr(cur, "AXChildren"))
        if i > 0, let menu = items.first, cfStr(attr(menu, "AXRole")) == "AXMenu" { items = cfElements(attr(menu, "AXChildren")) }
        guard let hit = items.first(where: { (cfStr(attr($0, "AXTitle")) ?? "").lowercased().hasPrefix(name.lowercased()) }) else {
            throw Fail(msg: "menu item not found: \(name); have: " + items.compactMap { cfStr(attr($0, "AXTitle")) }.filter { !$0.isEmpty }.joined(separator: " | "))
        }
        cur = hit
    }
    return perform(cur, "AXPress")
}

// MARK: - Commands
//
// Refs live for the lifetime of one axsnap process (`script` mode reads one command per line from
// stdin). A long-lived listener was deliberately not built for the spike: an IPC endpoint that
// lets any local process drive the UI through a TCC-granted binary is a confused deputy; the real
// helper speaks only the authenticated node protocol to the Gateway.

func parseOpts(_ args: inout [String]) throws -> Opts {
    var o = Opts()
    var rest: [String] = []
    var i = 0
    while i < args.count {
        let a = args[i]
        func next() throws -> String { i += 1; guard i < args.count else { throw Fail(msg: "missing value for \(a)") }; return args[i] }
        switch a {
        case "--depth": o.maxDepth = Int(try next()) ?? o.maxDepth
        case "--visit": o.maxVisit = Int(try next()) ?? o.maxVisit
        case "--emit": o.maxEmit = Int(try next()) ?? o.maxEmit
        case "--no-clip": o.clip = false
        case "--no-manual": o.manualAX = false
        case "--app": o.appRoot = true
        case "--no-prune": o.prune = false
        case "--menubar": o.menubar = true
        case "--json": o.json = true
        case "--window": o.window = Int(try next())
        case "--timeout": o.timeout = Float(try next()) ?? o.timeout
        default: rest.append(a)
        }
        i += 1
    }
    args = rest
    return o
}

let USAGE = """
usage: axrun <command…>              one command, fresh ref table
       axrun script < file            one command per line, refs persist across lines
commands:
  doctor | prompt | apps | activate <app> | sleep <ms>
  snap <app> [--depth N --visit N --emit N --no-clip --no-prune --menubar --json --window i]
  bench <app> [n]                    time n snapshots, report ref reuse
  press|focus|raise|confirm|cancel|showmenu|scrollto|pick|inc|dec <ref>
  custom <ref> <name>                NSAccessibilityCustomAction by name (or raw AX action)
  set <ref> <text>                   AXValue replace (verified)  | insert <ref> <text>  AXSelectedText
  select <ref>                       AXSelected=true (rows, tabs)
  get <ref> | value <ref>            all attributes | full value
  click <ref> [n] | clickxy <x> <y>  CGEvent click
  type <text> [--pid P] | key <combo> [--pid P]   CGEvent keyboard (cmd+n, return, …)
  scroll <ref> <lines>               CGEvent wheel at ref centre (negative = down)
  menu <app> "File>New Note"         press a menu item via AX
<ref> is e12, ?focused, or a selector ?role / ?role=label-substring that must match exactly one
node of the latest snapshot.
"""

var lastNodes: [Node] = []

func resolveArg(_ s: String) throws -> AXUIElement {
    guard s.hasPrefix("?") else { return try resolve(s) }
    if s == "?focused" {
        guard let n = lastNodes.first(where: { $0.flags.contains("focused") }) else { throw Fail(msg: "no focused element in the latest snapshot") }
        return try resolve(n.ref)
    }
    let q = s.dropFirst()
    let parts = q.split(separator: "=", maxSplits: 1).map(String.init)
    let hits = lastNodes.filter { n in
        (n.role == parts[0] || n.role.hasPrefix(parts[0] + ":")) &&
        (parts.count < 2 || (n.label ?? "").localizedCaseInsensitiveContains(parts[1]) || (n.value ?? "").localizedCaseInsensitiveContains(parts[1]))
    }
    guard let h = hits.first else { throw Fail(msg: "selector \(s) matched nothing in the latest snapshot") }
    // Never guess: an ambiguous selector once pressed "Add List: Groceries" instead of "Add Reminder".
    if hits.count > 1 { throw Fail(msg: "selector \(s) is ambiguous: " + hits.prefix(6).map { "\($0.ref) \($0.role) \"\($0.label ?? $0.value ?? "")\"" }.joined(separator: "; ")) }
    return try resolve(h.ref)
}

func run(_ argv: [String]) throws -> String {
    var args = argv
    let opts = try parseOpts(&args)
    var out = ""
    func say(_ s: String) { out += s + "\n" }
    func ref(_ i: Int = 1) throws -> AXUIElement {
        guard args.count > i else { throw Fail(msg: "missing <ref>") }
        return try resolveArg(args[i])
    }
    func app(_ i: Int = 1) throws -> NSRunningApplication {
        guard args.count > i, let a = findApp(args[i]) else { throw Fail(msg: "app not found") }
        return a
    }
    func check(_ r: AXError, _ what: String) throws {
        if r != .success { throw Fail(msg: "fail \(what): AXError \(r.rawValue)") }
        say("ok \(what)")
    }
    func argPid() -> pid_t? {
        if let i = args.firstIndex(of: "--pid"), i + 1 < args.count { let p = pid_t(args[i + 1]); args.removeSubrange(i...(i + 1)); return p }
        return nil
    }
    guard let cmd = args.first else { return USAGE }
    let arity = ["press": 2, "focus": 2, "raise": 2, "confirm": 2, "cancel": 2, "showmenu": 2, "scrollto": 2,
                 "pick": 2, "inc": 2, "dec": 2, "custom": 3, "set": 3, "insert": 3, "get": 2, "value": 2, "select": 2, "scroll": 3, "menu": 3]
    if let n = arity[cmd], args.count != n { throw Fail(msg: "\(cmd) takes \(n - 1) argument(s), got \(args.count - 1) (quote multi-word text)") }
    switch cmd {
    case "doctor":
        say("AXIsProcessTrusted=\(AXIsProcessTrusted())")
        say("CGPreflightPostEventAccess=\(CGPreflightPostEventAccess())")
        say("CGPreflightListenEventAccess=\(CGPreflightListenEventAccess())")
        say("CGPreflightScreenCaptureAccess=\(CGPreflightScreenCaptureAccess())")
        say("exe=\(CommandLine.arguments[0]) pid=\(getpid()) ppid=\(getppid())")
    case "prompt":
        let o = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        say("AXIsProcessTrustedWithOptions(prompt)=\(AXIsProcessTrustedWithOptions(o))")
    case "apps":
        for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
            say("\(a.processIdentifier)\t\(a.localizedName ?? "?")\t\(a.bundleIdentifier ?? "")\(isElectron(a) ? "\telectron" : "")")
        }
    case "activate":
        say(try app().activate() ? "ok activate" : "fail activate")
    case "appattr":
        // appattr <app> <name> [true|false]: read or write a boolean attribute on the app element
        let a = try app()
        var o = opts; o.manualAX = false
        let ae = appElement(a, o)
        guard args.count > 2 else { throw Fail(msg: "usage: appattr <app> <name> [true|false]") }
        if args.count > 3 {
            let r = AXUIElementSetAttributeValue(ae, args[2] as CFString, (args[3] == "true" ? kCFBooleanTrue : kCFBooleanFalse)!)
            say("set \(args[2])=\(args[3]) -> AXError \(r.rawValue)")
        }
        var v: CFTypeRef?
        let r = AXUIElementCopyAttributeValue(ae, args[2] as CFString, &v)
        say("get \(args[2]) -> AXError \(r.rawValue) value=\(cfStr(v) ?? "nil")")
    case "sleep":
        usleep(UInt32((args.count > 1 ? Int(args[1]) ?? 500 : 500) * 1000))
    case "snap":
        guard let r = snapshot(try app(), opts, session) else { throw Fail(msg: "no window (AX denied, app windowless, or window on another Space)") }
        snapGen += 1
        lastNodes = r.nodes
        let h = r.header
        out += r.text
        out += "# stats snap=\(snapGen) ms=\(h.ms) visited=\(h.visited) emitted=\(h.emitted) axCalls=\(h.axCalls) prunedContainers=\(h.prunedContainers) prunedOffscreen=\(h.prunedOffscreen) newRefs=\(h.newRefs) reusedRefs=\(h.reusedRefs) bytes=\(r.text.utf8.count) ~tokens=\(r.text.utf8.count / 4) truncated=\(h.truncated ?? "no")\n"
    case "bench":
        let a = try app()
        let n = args.count > 2 ? Int(args[2]) ?? 5 : 5
        var times: [Double] = []
        var last: SnapResult?
        for _ in 0..<n {
            guard let r = snapshot(a, opts, session) else { throw Fail(msg: "no window") }
            times.append(r.header.ms); last = r
            say("ms=\(r.header.ms) visited=\(r.header.visited) emitted=\(r.header.emitted) axCalls=\(r.header.axCalls) new=\(r.header.newRefs) reused=\(r.header.reusedRefs) bytes=\(r.text.utf8.count)")
        }
        lastNodes = last!.nodes
        let s = times.sorted()
        say("median_ms=\(s[s.count / 2]) min_ms=\(s.first!) max_ms=\(s.last!) bytes=\(last!.text.utf8.count) ~tokens=\(last!.text.utf8.count / 4)")
    case "press", "focus", "raise", "confirm", "cancel", "showmenu", "scrollto", "pick", "inc", "dec":
        let e = try ref()
        if cmd == "focus" { try check(AXUIElementSetAttributeValue(e, "AXFocused" as CFString, kCFBooleanTrue), "focus \(args[1])"); break }
        let map = ["press": "AXPress", "raise": "AXRaise", "confirm": "AXConfirm", "cancel": "AXCancel",
                   "showmenu": "AXShowMenu", "scrollto": "AXScrollToVisible", "pick": "AXPick", "inc": "AXIncrement", "dec": "AXDecrement"]
        try check(perform(e, map[cmd]!), "\(cmd) \(args[1])")
    case "custom", "action":
        let e = try ref()
        guard args.count > 2 else { throw Fail(msg: "usage: custom <ref> <name>") }
        guard let raw = actionNames(e).first(where: { $0 == args[2] || customActionName($0) == args[2] }) else {
            throw Fail(msg: "no action \(args[2]); have: " + actionNames(e).map(customActionName).joined(separator: ", "))
        }
        try check(perform(e, raw), "\(cmd) \(args[1]) \(args[2])")
    case "set", "insert":
        let e = try ref()
        guard args.count > 2 else { throw Fail(msg: "usage: \(cmd) <ref> <text>") }
        say("ok \(cmd) \(args[1]): " + (try setValue(e, args[2], attr: cmd == "set" ? "AXValue" : "AXSelectedText")))
    case "select":
        let e = try ref()
        guard settable(e, "AXSelected") else { throw Fail(msg: "AXSelected not settable") }
        try check(AXUIElementSetAttributeValue(e, "AXSelected" as CFString, kCFBooleanTrue), "select \(args[1])")
    case "value":
        say(cfStr(attr(try ref(), "AXValue")) ?? "")
    case "get":
        let e = try ref()
        var names: CFArray?
        AXUIElementCopyAttributeNames(e, &names)
        for n in (names as? [String]) ?? [] {
            let v = attr(e, n)
            let s = cfStr(v) ?? cfPoint(v).map { "\($0)" } ?? cfSize(v).map { "\($0)" }
                ?? (v.map { CFGetTypeID($0) == CFArrayGetTypeID() ? "[\(($0 as! [AnyObject]).count) items]" : String(describing: CFCopyTypeIDDescription(CFGetTypeID($0))!) } ?? "nil")
            say("\(n)\(settable(e, n) ? " (settable)" : "") = \(trunc(s, 300) ?? "")")
        }
        say("actions = \(actionNames(e).map(customActionName).joined(separator: ", "))")
    case "click":
        guard let p = center(try ref()) else { throw Fail(msg: "no frame") }
        mouseClick(p, count: args.count > 2 ? Int(args[2]) ?? 1 : 1); say("ok click \(args[1]) @\(Int(p.x)),\(Int(p.y))")
    case "clickxy":
        guard args.count > 2, let x = Double(args[1]), let y = Double(args[2]) else { throw Fail(msg: "usage: clickxy x y") }
        mouseClick(CGPoint(x: x, y: y)); say("ok clickxy")
    case "type":
        let pid = argPid()
        guard args.count > 1 else { throw Fail(msg: "usage: type <text>") }
        typeText(args[1], pid: pid); say("ok type \(args[1].count) chars")
    case "key":
        let pid = argPid()
        guard args.count > 1 else { throw Fail(msg: "usage: key <combo>") }
        try key(args[1], pid: pid); say("ok key \(args[1])")
    case "scroll":
        guard let p = center(try ref()), args.count > 2, let n = Int32(args[2]) else { throw Fail(msg: "usage: scroll <ref> <lines>") }
        scroll(at: p, dy: n); say("ok scroll")
    case "menu":
        let a = try app()
        guard args.count > 2 else { throw Fail(msg: "usage: menu <app> <path>") }
        try check(try menuPress(a, args[2]), "menu \(args[2])")
    default:
        throw Fail(msg: "unknown command \(cmd)\n" + USAGE)
    }
    return out
}

/// Split a script line shell-style: whitespace-separated, "double quotes" group, \n and \" escapes.
func splitLine(_ line: String) -> [String] {
    var out: [String] = [], cur = "", inQ = false, esc = false, has = false
    for ch in line {
        if esc { cur.append(ch == "n" ? "\n" : ch); esc = false; continue }
        if ch == "\\" { esc = true; has = true; continue }
        if ch == "\"" { inQ.toggle(); has = true; continue }
        if ch.isWhitespace && !inQ { if has { out.append(cur); cur = ""; has = false }; continue }
        cur.append(ch); has = true
    }
    if has { out.append(cur) }
    return out
}

let argv = Array(CommandLine.arguments.dropFirst())
if argv.first == "script" {
    var failed = false
    while let line = readLine() {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.isEmpty || t.hasPrefix("#") { continue }
        print("$ \(t)")
        do { print(try run(splitLine(t)), terminator: "") }
        catch let f as Fail { print("ERR \(f.msg)"); failed = true }
        catch { print("ERR \(error)"); failed = true }
    }
    exit(failed ? 1 : 0)
}
do { print(try run(argv), terminator: "") } catch let f as Fail { die(f.msg) } catch { die("\(error)") }
