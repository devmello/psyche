import Foundation
import PsycheProtocol

// Teach by showing in a Mac app (J8 phase 2, docs/design/teach-by-showing-2026.md §13).
//
// The owner picks one app they already granted for computer use; the helper watches that app's
// accessibility events (focus, value changed, a press, a menu item chosen) and turns them into
// semantic steps: "In Mail, click 'New Message'", "Type into 'Subject'", "Choose File > Export".
//
// Everything that decides what may be kept lives here, as pure functions and a small state
// machine, so it is tested against recorded AX event fixtures without a TCC grant:
//   - which apps may be recorded at all (`AppTeachPolicy.refusal`),
//   - which fields are secret (`AppTeachPolicy.sensitiveReason`),
//   - how events become steps (`AppTeachMapper`).
// The live source (AXObserver) and the indicator are in PsycheHelperSystem and only feed events in.

/// What the source read from the accessibility tree for one event. Never contains a field's
/// contents except `valueChanged`'s `value`, which the source only reads for a field that passed
/// `AppTeachPolicy.isSecret` and which the mapper checks again.
public struct AppTeachElement: Sendable, Equatable {
    public var bundleId: String
    public var appName: String
    public var role: String
    public var subrole: String?
    public var title: String?
    public var description: String?
    public var identifier: String?
    public var placeholder: String?
    /// Text of the element's `AXTitleUIElement` (the label drawn next to a field).
    public var labelText: String?
    /// Titles from the window down to the element's parent, outermost first. Empty titles dropped.
    public var path: [String]
    /// For a menu item: the menu-bar titles down to the item, e.g. ["File", "Export"].
    public var menuPath: [String]
    /// Secure Event Input was on when the event arrived (a password field somewhere has focus).
    public var secureInput: Bool
    /// Titles of linked or neighbouring label elements (`AXLinkedUIElements`).
    public var nearby: [String]
    /// The window's title and the few static texts just before the field. Read only to judge
    /// whether the field is a secret ("Two-factor authentication", "Enter the code"); never put
    /// in a step, a path or anything that leaves the helper.
    public var context: [String]
    /// The process the element belongs to; 0 when the source did not say.
    public var pid: Int32

    public init(
        bundleId: String, appName: String, role: String, subrole: String? = nil, title: String? = nil, description: String? = nil,
        identifier: String? = nil, placeholder: String? = nil, labelText: String? = nil, path: [String] = [], menuPath: [String] = [],
        secureInput: Bool = false, nearby: [String] = [], context: [String] = [], pid: Int32 = 0
    ) {
        self.bundleId = bundleId
        self.appName = appName
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.identifier = identifier
        self.placeholder = placeholder
        self.labelText = labelText
        self.path = path
        self.menuPath = menuPath
        self.secureInput = secureInput
        self.nearby = nearby
        self.context = context
        self.pid = pid
    }

    /// The name a person would give the element.
    public var name: String? {
        for c in [title, labelText, description, placeholder] {
            if let c = AppTeachText.clean(c, 120) { return c }
        }
        return nil
    }

    /// Same field for typing purposes (a field's title may change as the owner types).
    func sameField(_ o: AppTeachElement) -> Bool {
        bundleId == o.bundleId && role == o.role && identifier == o.identifier && (identifier != nil || (name == o.name && path == o.path))
    }
}

public enum AppTeachEvent: Sendable, Equatable {
    /// `initial` is the field's value when it got focus (read only for a field that is not secret):
    /// what was already there is not what the owner typed.
    case focus(AppTeachElement, initial: String? = nil)
    /// Focus left every field we may watch: the app went to the background, or the new element is
    /// outside the recorded process or not one we describe.
    case focusCleared
    /// `value` is the field's whole value after the change (nil when the source did not read it).
    case valueChanged(AppTeachElement, value: String?)
    /// A mouse press or `AXPress` on a control.
    case press(AppTeachElement)
    /// A menu item was chosen (not just highlighted).
    case menuChosen(AppTeachElement)
}

/// One recorded step; the wire shape is `TeachAppCapturedStep` in the protocol.
public struct AppTeachStep: Codable, Sendable, Equatable {
    public struct App: Codable, Sendable, Equatable {
        public var bundleId: String
        public var name: String
    }

    public var id: String
    public var kind: String  // app_click | app_type | app_menu
    public var app: App
    public var role: String?
    public var name: String?
    public var path: [String]?
    public var fallback: String?
    public var sensitive: Bool?
    /// What the owner typed, for review only. Never set on a sensitive step.
    public var sample: String?
}

public enum AppTeachText {
    /// One line of app text: control characters flattened, trimmed, capped. Nil when empty.
    public static func clean(_ s: String?, _ max: Int) -> String? {
        guard let s else { return nil }
        let flat = AXText.singleLine(s).replacingOccurrences(of: "⏎", with: " ")
        let trimmed = flat.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !trimmed.isEmpty else { return nil }
        return trimmed.count > max ? String(trimmed.prefix(max - 1)) + "…" : trimmed
    }
}

/// Why a field's contents are never recorded.
public enum AppTeachSensitive: String, Sendable {
    case password, payment, oneTimeCode, identity, secret
}

public enum AppTeachRefusal: String, Sendable, Equatable {
    /// The owner has not granted this app (Settings → Computer use), or it is on Off / Ask.
    case notGranted = "app_not_granted"
    case psyche = "psyche_app"
    case securityPrompt = "security_prompt"
    case passwordManager = "password_manager"
    /// Finance apps, browsers and terminals: computer use cannot act there, so a recording would
    /// be useless, and typing in a terminal is a command.
    case offLimits = "app_off_limits"

    public var message: String {
        switch self {
        case .notGranted: "Psyche can only record in an app you already allowed for computer use."
        case .psyche: "Psyche never records its own windows."
        case .securityPrompt: "Sign-in and security prompts are never recorded."
        case .passwordManager: "Password managers are never recorded."
        case .offLimits: "This kind of app cannot be recorded (banking, browsers, terminals and settings are off limits)."
        }
    }
}

public enum AppTeachPolicy {
    /// System processes that draw sign-in, approval and password panels. Matches the broker's
    /// locked-off list; the Keychain Access password panels belong to `com.apple.keychainaccess`.
    static let securityUIs = [
        "com.apple.loginwindow", "com.apple.securityagent", "com.apple.localauthentication.uiagent", "com.apple.coreservices.uiagent",
        "com.apple.keychainaccess", "com.apple.usernotificationcenter", "com.apple.notificationcenterui",
        "com.apple.systempreferences", "com.apple.systemsettings",
    ]

    /// Whether `bundleId` may be recorded given the owner's tiers. Order matters: a security UI is
    /// refused as a security UI even when someone listed it as granted.
    public static func refusal(bundleId: String, settings: TierSettings) -> AppTeachRefusal? {
        if let r = neverRecorded(bundleId) { return r }
        guard FixedCaps.cap(for: bundleId) == .interact else { return .offLimits }
        // Read alone is not enough: a recording is only worth keeping where the agent may act.
        switch settings.value(for: bundleId) {
        case .click, .interact: return nil
        case .read, .off, .ask: return .notGranted
        }
    }

    /// The apps no setting can unlock: Psyche, security prompts, password managers.
    public static func neverRecorded(_ bundleId: String) -> AppTeachRefusal? {
        let id = bundleId.lowercased()
        switch FixedCaps.category(of: bundleId) {
        case .psyche?: return .psyche
        case .passwordManager?: return .passwordManager
        case .systemAuthority?: return .securityPrompt
        default: break
        }
        if securityUIs.contains(id) { return .securityPrompt }
        // The shared list (generated from `TEACH_NEVER_APPS` in the protocol package).
        if TeachNeverApps.patterns.contains(where: { matches($0.lowercased(), id) }) { return .offLimits }
        return nil
    }

    static func matches(_ pattern: String, _ id: String) -> Bool {
        pattern.hasSuffix(".") ? id.hasPrefix(pattern) : (id == pattern || id.hasPrefix(pattern + "."))
    }

    // MARK: Sensitive fields

    /// The same words as `TEACH_SENSITIVE_WORDS` in `packages/protocol/src/browser-teach.ts`.
    /// Matched case-insensitively against a field's title, description, identifier, placeholder
    /// and label.
    static let words: [(AppTeachSensitive, NSRegularExpression)] = {
        let table: [(AppTeachSensitive, String)] = [
            (.password,
             "pass(?:word|code|phrase)|passwd|\\bpwd\\b|\\bpass\\b|\\bpw\\b|contrase\u{00F1}a|\\bclave\\b|mot[- ]?de[- ]?passe|passwort|kennwort|\\bsenha\\b|\\bparola\\b|\\bpassord\\b|\u{043F}\u{0430}\u{0440}\u{043E}\u{043B}\u{044C}|\u{5BC6}\u{7801}|\u{5BC6}\u{78BC}|\u{30D1}\u{30B9}\u{30EF}\u{30FC}\u{30C9}|\u{BE44}\u{BC00}\u{BC88}\u{D638}|\u{0E23}\u{0E2B}\u{0E31}\u{0E2A}\u{0E1C}\u{0E48}\u{0E32}\u{0E19}|\u{092A}\u{093E}\u{0938}\u{0935}\u{0930}\u{094D}\u{0921}|\u{0643}\u{0644}\u{0645}\u{0629} \u{0627}\u{0644}\u{0645}\u{0631}\u{0648}\u{0631}"),
            (.oneTimeCode,
             "\\b(?:otp|2fa|mfa|totp|one[- ]?time|verification[- ]code|security[- ]code|auth(?:entication)?[- ]code|sms[- ]code)\\b|(?:recovery|backup|reset)[- ]?(?:code|key)s?\\b"),
            (.payment,
             "card[- _]?(?:number|no|num)|\\bcc[-_ ]?(?:num|number|exp|csc|cvc|cvv)|\\bcv[vc]2?\\b|\\bcsc\\b|expir(?:y|ation)|\\biban\\b|routing[- ]number|account[- ]number|sort[- ]code|\\bswift\\b"),
            (.identity,
             "\\bssn\\b|social[- ]security|passport|national[- ]id|tax[- ]id|\\btin\\b|driver'?s?[- ]licen[cs]e"),
            (.secret,
             "\\bsecret\\b|api[- ]?key|(?:access|auth)[- ]token|private[- ]key|\\bpin\\b|seed[- ]?phrase|mnemonic|recovery[- ]phrase|secret[- ]recovery"),
        ]
        return table.compactMap { reason, source in
            (try? NSRegularExpression(pattern: source, options: [.caseInsensitive])).map { (reason, $0) }
        }
    }()

    /// Why an element's contents are secret, or nil. Decided from the element alone, before any
    /// value is read: a secure text field, Secure Event Input, or words in its labels.
    public static func sensitiveReason(_ e: AppTeachElement) -> AppTeachSensitive? {
        if e.secureInput || e.role == "AXSecureTextField" || e.subrole == "AXSecureTextField" { return .password }
        let text = ([e.title, e.description, e.identifier, e.placeholder, e.labelText].compactMap { $0 } + e.path + e.nearby + e.context)
            .joined(separator: " ")
        guard !text.isEmpty else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        for (reason, re) in words where re.firstMatch(in: text, options: [], range: range) != nil { return reason }
        return nil
    }

    public static func isSecret(_ e: AppTeachElement) -> Bool { sensitiveReason(e) != nil }

    /// A value that is a secret whatever field it was typed into (a card number, an ID number, a
    /// token). Mirrors `classifyTeachValue` in browser-teach.ts.
    public static func valueReason(_ value: String, label: String = "") -> AppTeachSensitive? {
        func matches(_ pattern: String, in s: String) -> [String] {
            guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
            return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { Swift.Range($0.range, in: s).map { String(s[$0]) } }
        }
        for m in matches("(?:\\d[ -]?){13,19}", in: value) {
            let digits = m.filter(\.isNumber)
            if (13...19).contains(digits.count), luhn(digits) { return .payment }
        }
        if !matches("\\b\\d{3}-\\d{2}-\\d{4}\\b", in: value).isEmpty { return .identity }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !matches("^[A-Za-z0-9_-]{32,}$", in: trimmed).isEmpty { return .secret }
        if !matches("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.", in: value).isEmpty { return .secret }
        if !matches("\\b(?:sk|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}", in: value).isEmpty { return .secret }
        // Credentials in a URL: a scheme, then user and password before an @ and the host
        if !matches("[A-Za-z][A-Za-z0-9+.-]*://[^/\\s:@]+:[^/\\s@]+@", in: value).isEmpty { return .secret }
        // A recovery phrase: 12, 15, 18, 21 or 24 short lowercase words (BIP39 shapes).
        let words = trimmed.split(whereSeparator: { $0.isWhitespace })
        if [12, 15, 18, 21, 24].contains(words.count),
           words.allSatisfy({ $0.count >= 3 && $0.count <= 8 && $0.allSatisfy { $0.isASCII && $0.isLowercase && $0.isLetter } }) { return .secret }
        // A bare 4 to 8 digit number typed into an app: a code or a PIN far more often than not, and
        // one click on "Keep this value" is too easy.
        if !matches("^\\d{4,8}$", in: trimmed).isEmpty { return .oneTimeCode }
        // A short numeric code next to a label that says code, pin, otp or token.
        if !matches("^\\d{4,8}$", in: trimmed).isEmpty, !matches("\\b(?:code|pin|otp|token)\\b", in: label.lowercased()).isEmpty { return .oneTimeCode }
        return nil
    }

    static func luhn(_ digits: String) -> Bool {
        var sum = 0
        var dbl = false
        for ch in digits.reversed() {
            guard var n = ch.wholeNumberValue else { return false }
            if dbl {
                n *= 2
                if n > 9 { n -= 9 }
            }
            sum += n
            dbl = !dbl
        }
        return sum % 10 == 0
    }
}

/// AX roles as the recording keeps them: a fixed list shared with the protocol (`TEACH_ROLES`).
public enum AppTeachRoles {
    public static func map(_ role: String, _ subrole: String?) -> String {
        switch role {
        case "AXButton", "AXMenuButton", "AXDisclosureTriangle": return "button"
        case "AXTextField", "AXTextArea", "AXSecureTextField": return "textbox"
        case "AXSearchField": return "searchbox"
        case "AXComboBox", "AXPopUpButton": return "combobox"
        case "AXCheckBox": return subrole == "AXSwitch" ? "switch" : "checkbox"
        case "AXRadioButton": return "radio"
        case "AXMenuItem", "AXMenuBarItem": return "menuitem"
        case "AXLink": return "link"
        case "AXSlider": return "slider"
        case "AXRow": return "row"
        case "AXCell": return "cell"
        case "AXTabGroup": return "tablist"
        case "AXTable", "AXOutline": return "table"
        case "AXToolbar": return "toolbar"
        case "AXList": return "list"
        case "AXImage": return "img"
        default: return "generic"
        }
    }

    /// Rows, cells and list items hold the user's data (a message subject, a file name), not the
    /// app's controls: they are recorded by role, never by what they contain.
    public static let dataRoles: Set<String> = ["AXRow", "AXCell", "AXOutlineRow", "AXStaticText", "AXPopUpButton"]

    /// Ancestors whose title is the user's data (a row's text, a page's title, the open tabs).
    public static let dataAncestors: Set<String> = ["AXRow", "AXCell", "AXOutlineRow", "AXStaticText", "AXWebArea", "AXTabGroup", "AXList", "AXTable", "AXOutline"]

    /// The title an ancestor may add to a path, or nil when it is the user's data or only a window.
    public static func pathTitle(role: String, title: String?) -> String? {
        if role == "AXWindow" || role == "AXApplication" || dataAncestors.contains(role) { return nil }
        guard let t = AppTeachText.clean(title, 120) else { return nil }
        return t
    }

    /// Menus whose items are the user's data (recent documents, history, bookmarks, the window list).
    public static func isDynamicMenu(_ title: String) -> Bool {
        let t = title.lowercased()
        return ["recent", "history", "bookmarks", "window", "documents", "favorites", "open with"].contains { t.contains($0) }
    }

    /// Roles whose press means "the owner moved into a field", not an action.
    public static let textInputs: Set<String> = ["AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField", "AXComboBox"]
    public static let menuItems: Set<String> = ["AXMenuItem", "AXMenuBarItem"]
}

/// Turns events into steps. One mapper per recording; events from other apps are ignored, and
/// events from apps that are never recorded are counted and dropped.
public final class AppTeachMapper: @unchecked Sendable {
    public static let maxSteps = 200
    public static let maxSample = 500

    public let app: AppTeachStep.App
    public private(set) var steps: [AppTeachStep] = []
    /// Input left out: a secret field's contents, a control with no usable name, a never-recorded app.
    public private(set) var skipped = 0
    private var pending: (element: AppTeachElement, text: String, at: Date, baseline: String?)?
    /// The value the focused field had when it got focus.
    private var focusBaseline: String?
    /// The field that has focus: value changes are accepted from it and from nowhere else.
    private var focused: AppTeachElement?
    /// The process the recording is bound to (set at start); events from any other pid are dropped.
    private var boundPid: Int32?
    /// Fields already recorded as sensitive, so retyping into one does not add a step each time.
    private var sensitiveFields: [AppTeachElement] = []
    private let lock = NSLock()
    private let maxSteps: Int

    public init(bundleId: String, appName: String, maxSteps: Int = AppTeachMapper.maxSteps) {
        app = .init(bundleId: bundleId, name: AppTeachText.clean(appName, 120) ?? bundleId)
        self.maxSteps = max(1, min(Self.maxSteps, maxSteps))
    }

    public var limitReached: Bool { lock.withLock { steps.count >= maxSteps } }

    /// Binds the recording to one process. The bundle id is a string anyone can claim; the pid is
    /// what the OS handed the source.
    public func bind(pid: Int32) { lock.withLock { boundPid = pid } }
    public var stepCount: Int { lock.withLock { steps.count } }

    /// Feeds one event; returns the steps it finalized.
    @discardableResult
    public func handle(_ event: AppTeachEvent, at: Date = Date()) -> [AppTeachStep] {
        lock.lock()
        defer { lock.unlock() }
        if case .focusCleared = event {
            let out = flushLocked()
            focused = nil
            focusBaseline = nil
            return out
        }
        let e = Self.element(of: event)
        if let pid = boundPid, e.pid != pid {
            // A foreign element means focus is no longer in the recorded process.
            if case .focus = event { let out = flushLocked(); focused = nil; focusBaseline = nil; return out }
            return []
        }
        if e.bundleId.lowercased() != app.bundleId.lowercased() {
            // Another app: never recorded. A security prompt or Psyche is counted so the review can say so.
            if AppTeachPolicy.neverRecorded(e.bundleId) != nil { skipped += 1 }
            return []
        }
        if AppTeachPolicy.neverRecorded(app.bundleId) != nil { skipped += 1; return [] }
        guard steps.count < maxSteps else { return [] }
        var out: [AppTeachStep] = []
        switch event {
        case .focusCleared:
            break
        case .focus(let el, let initial):
            if let p = pending, !p.element.sameField(el) { out += flushLocked() }
            if focused?.sameField(el) != true { focusBaseline = initial }
            focused = el
        case .valueChanged(let el, let value):
            out += valueLocked(el, value, at)
        case .press(let el):
            out += flushLocked()
            out += pressLocked(el)
        case .menuChosen(let el):
            out += flushLocked()
            out += menuLocked(el)
        }
        return out
    }

    /// Ends the recording: flushes typing and returns everything recorded.
    public func finish() -> [AppTeachStep] {
        lock.lock()
        defer { lock.unlock() }
        _ = flushLocked()
        return steps
    }

    static func element(of event: AppTeachEvent) -> AppTeachElement {
        switch event {
        case .focus(let e, _), .press(let e), .menuChosen(let e): e
        case .valueChanged(let e, _): e
        case .focusCleared: AppTeachElement(bundleId: "", appName: "", role: "")
        }
    }

    // MARK: Typing

    private func valueLocked(_ el: AppTeachElement, _ value: String?, _ at: Date) -> [AppTeachStep] {
        var out: [AppTeachStep] = []
        // Only text fields are typed into: a label or a progress bar whose value changes is not input.
        guard AppTeachRoles.textInputs.contains(el.role) || el.subrole == "AXSecureTextField" else { return out }
        // And only the field that has focus: a value changing elsewhere in the app is not the owner typing.
        guard let focus = focused, focus.sameField(el) else { return out }
        // A secret field: one sensitive step, no value, and the value is not even looked at.
        if AppTeachPolicy.isSecret(el) {
            if pending != nil { out += flushLocked() }
            if !sensitiveFields.contains(where: { $0.sameField(el) }) {
                sensitiveFields.append(el)
                out.append(appendLocked(kind: "app_type", el, sensitive: true))
            }
            return out
        }
        guard let value else { return out }
        if let p = pending, !p.element.sameField(el) { out += flushLocked() }
        pending = (el, value, pending?.at ?? at, pending?.baseline ?? focusBaseline)
        return out
    }

    private func flushLocked() -> [AppTeachStep] {
        guard let p = pending, steps.count < maxSteps else {
            pending = nil
            return []
        }
        pending = nil
        // The value is checked once more, whatever the source decided: a card number or token
        // typed into an unlabelled field makes the step sensitive and drops the value.
        let label = ([p.element.name ?? ""] + p.element.context).joined(separator: " ")
        if AppTeachPolicy.isSecret(p.element) || AppTeachPolicy.valueReason(p.text, label: label) != nil {
            skipped += 1
            return [appendLocked(kind: "app_type", p.element, sensitive: true)]
        }
        // Only what the owner typed after the field got focus: a value that was already there
        // (pre-filled, autofilled) is not recorded, and an append keeps just the appended part.
        var typed = p.text
        if let base = p.baseline, !base.isEmpty {
            if typed == base { return [] }
            if typed.hasPrefix(base) { typed = String(typed.dropFirst(base.count)) }
        }
        if typed != p.text, AppTeachPolicy.valueReason(typed, label: label) != nil {
            skipped += 1
            return [appendLocked(kind: "app_type", p.element, sensitive: true)]
        }
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        // Emptied fields are not a step: the owner typed and deleted.
        guard !text.isEmpty else { return [] }
        let sample = String(AppTeachText.clean(text, Self.maxSample) ?? "")
        return [appendLocked(kind: "app_type", p.element, sample: sample.isEmpty ? nil : sample)]
    }

    // MARK: Presses and menus

    private func pressLocked(_ el: AppTeachElement) -> [AppTeachStep] {
        // Moving into a field is a focus, not an action; the typing that follows is the step.
        if AppTeachRoles.textInputs.contains(el.role) { return [] }
        if AppTeachRoles.menuItems.contains(el.role) { return menuLocked(el) }
        // A secret control (a "Show password" button) is not described either.
        if AppTeachPolicy.isSecret(el) { skipped += 1; return [] }
        // A row or cell is the user's data: recorded as "a row", never by its contents.
        if AppTeachRoles.dataRoles.contains(el.role) {
            if let last = steps.last, last.kind == "app_click", last.role == AppTeachRoles.map(el.role, el.subrole), last.name == nil { return [] }
            return [appendLocked(kind: "app_click", el)]
        }
        guard el.name != nil || AppTeachText.clean(el.identifier, 200) != nil else {
            skipped += 1  // not replayable: nothing a person or the next run could find it by
            return []
        }
        if let last = steps.last, last.kind == "app_click", Self.sameTarget(last, el) { return [] }  // double press
        return [appendLocked(kind: "app_click", el)]
    }

    private func menuLocked(_ el: AppTeachElement) -> [AppTeachStep] {
        var path = el.menuPath.compactMap { AppTeachText.clean($0, 120) }
        if path.isEmpty, let name = el.name { path = [name] }
        guard !path.isEmpty else { skipped += 1; return [] }
        // Open Recent, History, the Window list: the items are the user's data, so the step stops at the menu.
        if let i = path.dropLast().firstIndex(where: AppTeachRoles.isDynamicMenu) { path = Array(path.prefix(i + 1)) }
        else if path.count == 1, AppTeachRoles.isDynamicMenu(path[0]) { path = [path[0]] }
        return [appendLocked(kind: "app_menu", el, menuPath: path)]
    }

    static func sameTarget(_ s: AppTeachStep, _ e: AppTeachElement) -> Bool {
        s.name == e.name && s.fallback == fallback(of: e) && s.role == AppTeachRoles.map(e.role, e.subrole)
    }

    /// A second way to find the element: its accessibility identifier, else a description that
    /// differs from its name.
    static func fallback(of e: AppTeachElement) -> String? {
        if let id = AXText.cleanIdentifier(e.identifier).flatMap({ AppTeachText.clean($0, 200) }) { return "identifier:\(id)" }
        if let d = AppTeachText.clean(e.description, 200), d != e.name { return "description:\(d)" }
        return nil
    }

    private func appendLocked(kind: String, _ el: AppTeachElement, sensitive: Bool = false, sample: String? = nil, menuPath: [String]? = nil) -> AppTeachStep {
        var path: [String]? = nil
        let data = AppTeachRoles.dataRoles.contains(el.role)
        if data {
            // By role only: no title, description, identifier or path from the user's data.
            let role = AppTeachRoles.map(el.role, el.subrole)
            let step = AppTeachStep(id: "a\(steps.count + 1)", kind: kind, app: app, role: role, name: nil, path: [role == "generic" ? "item" : role], fallback: nil, sensitive: nil, sample: nil)
            steps.append(step)
            return step
        }
        if let menuPath {
            path = Array(menuPath.prefix(8))
        } else {
            var p = el.path.compactMap { AppTeachText.clean($0, 120) }
            if let n = el.name, p.last != n { p.append(n) }
            path = p.isEmpty ? nil : Array(p.suffix(8))
        }
        let step = AppTeachStep(
            id: "a\(steps.count + 1)", kind: kind, app: app,
            role: kind == "app_menu" ? "menuitem" : AppTeachRoles.map(el.role, el.subrole),
            name: kind == "app_menu" ? menuPath?.last : el.name,
            path: path, fallback: Self.fallback(of: el), sensitive: sensitive ? true : nil, sample: sensitive ? nil : sample
        )
        steps.append(step)
        return step
    }
}
