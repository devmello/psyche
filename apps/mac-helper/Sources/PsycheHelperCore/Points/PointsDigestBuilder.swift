import CoreGraphics
import CryptoKit
import Foundation
import PsycheProtocol

/// What the helper keeps about one field between reads: the element handle and the judgement.
public struct PointsFieldRecord<Node: Hashable> {
    public var id: String
    public var node: Node
    public var role: PointsFieldRole
    public var label: String
    public var path: [String]
    public var sensitive: PointsSensitiveReason?
    public var fill: PointsFieldFill
    public var frame: CGRect?
    public var enabled: Bool?
    public var focused: Bool
    /// What the judge saw, kept so the engine can judge the element again before any value is read.
    public var facts: PointsFieldFacts
    public var directionsOnly: Bool
}

/// One full read of the window: the wire digest plus the helper-side records.
public struct PointsRead<Node: Hashable> {
    public var digest: PointsDigest
    public var records: [PointsFieldRecord<Node>]
    /// The page is on the directions-only list (§2.2): every field counts as sensitive.
    public var directionsOnly: Bool
    /// Counts the owner can see in a test or a log, never texts.
    public var visited: Int
}

/// Maps AX roles to the fixed role list of §3.1. Anything not listed is not a field.
public enum PointsRoleMap {
    public static func fieldRole(role: String, subrole: String?) -> PointsFieldRole? {
        switch role {
        case "AXTextField": return subrole == "AXNumberField" ? .number : .text
        case "AXSecureTextField": return .text
        case "AXSearchField": return .text
        case "AXTextArea": return .multiline
        case "AXComboBox": return .combobox
        case "AXPopUpButton", "AXMenuButton": return .popup
        case "AXCheckBox", "AXSwitch": return .checkbox
        case "AXRadioButton": return .radio
        case "AXSlider", "AXIncrementor", "AXStepper": return .number
        case "AXDateField", "AXDateTimeArea": return .date
        case "AXButton": return .button
        case "AXLink": return .link
        default: return nil
        }
    }

    /// Roles whose subtree is the field's own (a menu, a button label): not walked.
    static func isLeafField(role: String) -> Bool {
        fieldRole(role: role, subrole: nil) != nil && role != "AXComboBox"
    }

    static let groupRoles: Set<String> = ["AXGroup", "AXSheet", "AXTabGroup", "AXRadioGroup", "AXDrawer", "AXSplitGroup", "AXList", "AXToolbar", "AXOutline", "AXForm"]
}

/// Builds the digest of §3.1 over an abstract source (docs/design/psyche-points-2026.md). The one
/// rule this file exists for: **`fieldValue` is called only for a field that passed the sensitive
/// judge.** The judge runs on the element alone (labels, path, secure subrole), before any value.
public enum PointsDigestBuilder {
    public static let maxVisit = 4_000
    public static let maxEmit = 300
    /// Seconds one full read may take before it stops and marks the digest truncated.
    public static let budget: Double = 1.5
    static let maxDepth = 80

    private struct Candidate<Node: Hashable> {
        var node: Node
        var attrs: PointsAXAttributes
        var role: PointsFieldRole
        var label: String
        var facts: PointsFieldFacts
        var path: [String]
        var errorText: String?
        var parent: Int?
    }

    /// `ids` hands out stable field ids. `valueShape` holds fields a committed value showed to be a
    /// secret (they stay sensitive); `sensitiveFill` holds the filled-or-empty answer read once from
    /// a sensitive field when focus left it.
    public static func read<S: PointsAXSource>(
        source: S, target: PointsTarget, ids: inout PointsFieldIds<S.Node>, latched: [S.Node: PointsSensitiveReason] = [:],
        sensitiveFill: [S.Node: PointsFieldFill] = [:], budget: Double = PointsDigestBuilder.budget
    ) -> PointsRead<S.Node>? {
        guard let root = source.windowRoot() else { return nil }
        let secureInput = source.secureEventInput()
        let focused = source.focusedElement()
        var visited = 0
        var truncated = false
        var candidates: [Candidate<S.Node>] = []
        var headings: [String] = []
        var pageTexts: [String] = []
        var instructionParts: [String] = []
        var instructionChars = 0
        var webURL: String?
        var fillable = 0
        // A full read has a wall-clock budget: a hung app must not hold the observer thread.
        let deadline = ProcessInfo.processInfo.systemUptime + budget

        func clip(_ s: String?, _ n: Int = 120) -> String? { tidy(s, n) }

        var currentHeading: String?

        func visit(_ node: S.Node, depth: Int, groups: [String], parent: Int?, recent: inout [String], lastCandidate: inout Int?) {
            guard visited < maxVisit, depth <= maxDepth else { truncated = true; return }
            if ProcessInfo.processInfo.systemUptime > deadline { truncated = true; return }
            visited += 1
            var childParent = parent
            let a = source.attributes(node)
            if a.role == "AXWebArea" || (webURL == nil && a.url != nil && a.role == "AXDocument") {
                if webURL == nil, let u = a.url, !u.isEmpty { webURL = u }
            }
            switch a.role {
            case "AXStaticText":
                if let t = clip(a.text, 300) {
                    if pageTexts.count < 400 { pageTexts.append(String(t.prefix(200))) }
                    // The text after an invalid field is its error text.
                    if let idx = lastCandidate, candidates[idx].attrs.invalid == true, candidates[idx].errorText == nil {
                        candidates[idx].errorText = clip(t, 200)
                    }
                    lastCandidate = nil
                    recent.append(String(t.prefix(120)))
                    if recent.count > 2 { recent.removeFirst() }
                    if t.count >= 25, instructionChars < 2_000, !looksLikeSecret(t) {
                        instructionParts.append(t)
                        instructionChars += t.count + 1
                    }
                }
                return
            case "AXHeading":
                if let t = clip(a.text ?? a.title ?? a.description, 120) {
                    if pageTexts.count < 400 { pageTexts.append(t) }
                }
                if let t = clip(a.text ?? a.title ?? a.description, 120), !looksLikeSecret(t) {
                    currentHeading = t
                    if headings.count < 40 { headings.append(t) }
                    recent.append(t)
                    if recent.count > 2 { recent.removeFirst() }
                }
                return
            default: break
            }
            if let role = PointsRoleMap.fieldRole(role: a.role, subrole: a.subrole) {
                lastCandidate = nil
                let label = clip(a.title) ?? clip(a.titleElementText) ?? clip(a.description) ?? clip(a.placeholder) ?? clip(a.help) ?? ""
                if (role == .button || role == .link) && label.isEmpty { return }
                if role != .button && role != .link { fillable += 1 }
                var path = groups
                if let h = currentHeading, path.last != h { path.append(h) }
                path = Array(path.suffix(8)).map { String($0.prefix(120)) }
                let secure = a.role == "AXSecureTextField" || a.subrole == "AXSecureTextField"
                    || (secureInput && focused != nil && focused == node)
                var nearby = recent
                nearby += [a.description, a.titleElementText].compactMap { $0 }.map { String($0.prefix(120)) }
                nearby += a.linkedTexts.prefix(4).map { String($0.prefix(120)) }
                let facts = PointsFieldFacts(
                    label: label.isEmpty ? nil : label, placeholder: clip(a.placeholder), help: clip(a.help), identifier: a.identifier,
                    secure: secure, path: groups + (currentHeading.map { [$0] } ?? []), nearbyText: nearby)
                if candidates.count < maxEmit {
                    candidates.append(Candidate(node: node, attrs: a, role: role, label: label, facts: facts, path: path, parent: parent))
                    lastCandidate = candidates.count - 1
                    childParent = candidates.count - 1
                } else {
                    truncated = true
                }
                if PointsRoleMap.isLeafField(role: a.role) { return }
            }
            var g = groups
            if PointsRoleMap.groupRoles.contains(a.role), let t = clip(a.title) ?? clip(a.description) ?? clip(a.titleElementText) {
                g.append(t)
            }
            var childRecent: [String] = []
            var childLast: Int?
            for child in source.children(of: node) {
                visit(child, depth: depth + 1, groups: g, parent: childParent, recent: &childRecent, lastCandidate: &childLast)
                if visited >= maxVisit { truncated = true; break }
            }
        }

        var rootRecent: [String] = []
        var rootLast: Int?
        visit(root, depth: 0, groups: [], parent: nil, recent: &rootRecent, lastCandidate: &rootLast)

        // First judgement, from the elements alone: no value has been read yet.
        let rootAttrs = source.attributes(root)
        let judged = candidates.map { PointsSensitiveJudge.classify($0.facts, directionsOnly: false) }
        let (host, path, insecure) = splitURL(webURL)
        let title = clip(rootAttrs.title, 200) ?? clip(target.windowTitle, 200) ?? ""
        let page = PointsPageFacts(
            url: webURL, host: host, title: title, hasPaymentFields: judged.contains(.payment), insecure: insecure,
            texts: pageTexts)
        let directionsOnly = PointsSensitiveJudge.isDirectionsOnly(page)

        var records: [PointsFieldRecord<S.Node>] = []
        var fields: [PointsField] = []
        var finalReasons: [PointsSensitiveReason?] = []
        for (i, c) in candidates.enumerated() {
            guard let id = ids.id(for: c.node) else { truncated = true; finalReasons.append(.secureField); continue }
            var reason: PointsSensitiveReason? = c.facts.secure ? .secureField : directionsOnly ? .directionsOnly : judged[i]
            // A field inside a sensitive field (the text field of a password combo box) is sensitive too.
            if reason == nil, let p = c.parent, p < finalReasons.count, let pr = finalReasons[p] { reason = pr }
            // Once sensitive in this session, always: a relabel never clears it.
            if reason == nil, let l = latched[c.node] { reason = l }
            finalReasons.append(reason)
            let fill: PointsFieldFill
            if reason == nil, c.role != .button, c.role != .link {
                // The only place a field's value is read for the digest: the judge said it is plain.
                fill = fillState(role: c.role, value: source.fieldValue(of: c.node))
            } else {
                fill = sensitiveFill[c.node] ?? .unknown
            }
            let isFocused = focused.map { $0 == c.node } ?? (c.attrs.focused ?? false)
            let options = (reason == nil && c.role == .popup) ? source.options(of: c.node, limit: 40) : []
            var errorText = reason == nil ? c.errorText : nil
            if let e = errorText, looksLikeSecret(e) { errorText = nil }
            records.append(
                PointsFieldRecord(id: id, node: c.node, role: c.role, label: c.label, path: c.path, sensitive: reason, fill: fill,
                                  frame: c.attrs.frame, enabled: c.attrs.enabled, focused: isFocused, facts: c.facts, directionsOnly: directionsOnly))
            fields.append(
                PointsField(
                    enabled: c.attrs.enabled, errorText: errorText, fieldID: id, focused: isFocused ? true : nil,
                    frame: c.attrs.frame.map { PointsRect(height: $0.height, width: $0.width, x: $0.origin.x, y: $0.origin.y) },
                    invalid: reason == nil ? c.attrs.invalid : nil, label: c.label, options: options.isEmpty ? nil : options, path: c.path,
                    pointsFieldRequired: c.attrs.required, role: c.role, sensitive: reason, state: fill, value: nil))
        }

        let digest = PointsDigest(
            app: PointsDigestApp(bundleID: target.bundleId, name: target.appName), fields: fields,
            fingerprint: fingerprint(records), headings: headings, host: host, insecure: insecure ? true : nil,
            instructions: String(instructionParts.joined(separator: " ").prefix(2_000)), path: path,
            tree: fillable < 3 ? .sparse : .ok, truncated: truncated ? true : nil, windowTitle: title)
        return PointsRead(digest: digest, records: records, directionsOnly: directionsOnly, visited: visited)
    }

    /// One line of page text: whitespace and line breaks (NEL included) collapsed, capped. Invisible
    /// characters are kept on purpose: the judge must see what an attacker hid in a label, so a label
    /// is never cleaned before it is judged.
    static func tidy(_ s: String?, _ max: Int) -> String? {
        guard let s else { return nil }
        let t = s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        if t.isEmpty { return nil }
        return t.count > max ? String(t.prefix(max)) : t
    }

    /// The state of a field the judge cleared. The value itself is dropped here: the digest carries
    /// filled or empty only, and a value leaves the helper once, on commit.
    static func fillState(role: PointsFieldRole, value: String?) -> PointsFieldFill {
        guard let value else { return .unknown }
        let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
        switch role {
        case .checkbox, .radio: return (t == "1" || t.lowercased() == "true") ? .filled : .empty
        default: return t.isEmpty ? .empty : .filled
        }
    }

    /// A hash of the field roles and label paths only. A value, a focus or a frame change never
    /// moves it; a different set of fields does (§3.4: a new page).
    public static func fingerprint<Node: Hashable>(_ records: [PointsFieldRecord<Node>]) -> String {
        var h = SHA256()
        for r in records {
            h.update(data: Data("\(r.role.rawValue)\u{1F}\(r.path.joined(separator: "\u{1E}"))\u{1F}\(r.label)\n".utf8))
        }
        return h.finalize().prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    /// Host and path of the page, no query and no fragment; `insecure` for plain `http:`.
    static func splitURL(_ url: String?) -> (host: String?, path: String?, insecure: Bool) {
        guard let url, let c = URLComponents(string: url), let host = c.host?.lowercased(), !host.isEmpty else { return (nil, nil, false) }
        let path = c.path.isEmpty ? nil : String(c.path.prefix(200))
        return (String(host.prefix(200)), path, c.scheme?.lowercased() == "http")
    }

    /// Page text that shows a number or token of a secret shape is not sent (a static line that
    /// displays a card number, a token or an ID).
    static func looksLikeSecret(_ text: String) -> Bool {
        if AppTeachPolicy.valueReason(text) != nil { return true }
        let digits = text.filter(\.isNumber)
        return digits.count >= 9 && text.range(of: "\\d[\\d -./]{7,}\\d", options: .regularExpression) != nil
    }
}
