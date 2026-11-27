import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

extension GatewayBackend {
    /// `daily.followups.update`. The Gateway answers with the follow-up; the phone only needs it to have been accepted.
    public func actOnFollowup(id: String, action: FollowupAction, until: Date?) async throws {
        var params: [String: JSONValue] = ["id": .string(id), "action": .string(action.rawValue)]
        if let until { params["until"] = .string(until.formatted(.iso8601)) }
        _ = try await call("daily.followups.update", .object(params))
    }

    public func home() async throws -> HomeSnapshot {
        // Approvals and questions are the screen; the rest degrade to empty sections.
        async let approvals = settled { try await self.needsYouApprovals() }
        async let questions = settled { try await self.needsYouQuestions() }
        async let tasks = optional { try await self.runningTasks() }
        async let brief = optional { try await self.todayBrief() }
        let (a, q) = await (approvals, questions)
        if case .failure(let error) = a, case .failure = q { throw error }
        let needsYou = ((try? a.get()) ?? []) + ((try? q.get()) ?? [])
        return await HomeSnapshot(
            needsYou: needsYou,
            running: tasks ?? [], today: brief ?? [], keepInTouch: [], updatedAt: .now)
    }

    public func answerApproval(id: String, decision: ApprovalDecision) async throws {
        let current = try await call("approvals.get", .obj(["approvalId": .string(id)]))
        guard let approval = current["approval"] else { throw BackendError.notFound }
        if approval["status"]?.string != "pending" { throw BackendError.refused(String(localized: "That approval is no longer waiting.", bundle: .module)) }
        // Only presence-gated approvals (payments, adding a verifier) need a presence assertion from a registered
        // Secure Enclave key (companion §5); the phone has none yet, so these stay on the Mac rather than failing
        // late. Device-only just means "never in chat": the paired phone answers it with a plain tap. Long or nested
        // details are not a reason to refuse: the card shows every field in full, scrollable, before the tap.
        if approval["requiresAuthentication"]?.bool == true
            || (decision == .allow && Self.detailsNeedMac(approval["details"])) {
            throw BackendError.refused(String(localized: "This one needs your Mac. Answer it there.", bundle: .module))
        }
        guard let token = current["answerToken"]?.string else {
            throw BackendError.refused(String(localized: "This approval was sent to a different device.", bundle: .module))
        }
        // Approvals are never queued: the token is single use and the approval can expire.
        _ = try await call("approvals.answer", .obj([
            "approvalId": .string(id), "answerToken": .string(token),
            "decision": .string(decision == .allow ? "approve" : "deny"),
            "scope": decision == .allow ? "once" : nil,
        ]))
    }

    public func answerQuestion(id: String, answer: QuestionAnswer) async throws {
        let current = try await call("questions.get", .obj(["inputRequestId": .string(id)]))
        guard let request = current["inputRequest"], let questions = request["questions"]?.array, !questions.isEmpty
        else { throw BackendError.notFound }
        let wire = try Self.questionAnswerObject(answer, questions: questions)
        _ = try await call(
            "questions.answer", .obj(["inputRequestId": .string(id), "answer": .object(wire)]),
            key: "answer-\(id)")
    }

    /// The `questions.answer` object for every part of the request, keyed by each part's header. Every part must be
    /// answered, and no key may name a part the request does not have. A text answer is trimmed and sent as a
    /// string; a multi-select answer as an array of at most four.
    static func questionAnswerObject(_ answer: QuestionAnswer, questions: [JSONValue]) throws -> [String: JSONValue] {
        var values = answer.values
        // A single-part answer from a surface that doesn't know the header is filed under the request's only part.
        if let only = values.removeValue(forKey: QuestionAnswer.onlyPartKey), questions.count == 1,
           let header = questions[0]["header"]?.string, !header.isEmpty {
            values[header] = only
        }
        var wire: [String: JSONValue] = [:]
        var asked = Set<String>()
        for question in questions {
            guard let header = question["header"]?.string, !header.isEmpty else { throw BackendError.notFound }
            asked.insert(header)
            guard let value = values[header] else { throw BackendError.refused(String(localized: "Answer every question first.", bundle: .module)) }
            switch value {
            case .text(let text):
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { throw BackendError.refused(String(localized: "Answer every question first.", bundle: .module)) }
                guard trimmed.count <= QuestionDraft.maxTextLength else { throw BackendError.refused(String(localized: "That answer is too long.", bundle: .module)) }
                wire[header] = .string(trimmed)
            case .choices(let choices):
                let picked = choices.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                guard !picked.isEmpty else { throw BackendError.refused(String(localized: "Answer every question first.", bundle: .module)) }
                guard picked.count <= QuestionDraft.maxChoices else { throw BackendError.refused(String(localized: "Pick at most four answers.", bundle: .module)) }
                wire[header] = .array(picked.map { .string($0) })
            }
        }
        guard Set(values.keys).isSubset(of: asked) else { throw BackendError.refused(String(localized: "That answer does not match this question.", bundle: .module)) }
        return wire
    }

    public func actOnNudge(id: String, action: NudgeAction) async throws {
        let wire: String
        switch action {
        case .startMessage: return  // "Draft a reply" only fills the composer in the app; nothing goes to the Gateway.
        case .snooze: wire = "snooze_week"
        case .mute: wire = "mute_person"
        }
        _ = try await call("nudges.act", .obj(["id": .string(id), "action": .string(wire)]), key: "nudge-\(id)-\(wire)")
    }

    public func inbox() async throws -> [InboxItem] {
        try await inboxPage(cursor: nil).items
    }

    /// Rows per inbox page. The Gateway clamps to its own maximum.
    static let inboxPageSize = 50

    public func inboxPage(cursor: String?) async throws -> InboxPage {
        var params: [String: JSONValue] = ["limit": .number(Double(Self.inboxPageSize))]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await call("notifications.list", .object(params))
        let items: [InboxItem] = (result["notifications"]?.array ?? []).compactMap { n in
            guard let id = n["id"]?.string else { return nil }
            let kind = n["kind"]?.string ?? "system"
            let waiting = (kind == "approval" || kind == "input_needed") && n["resolvedAt"]?.string == nil
            return InboxItem(
                id: id, title: n["title"]?.string ?? "", body: n["body"]?.string ?? "",
                kindLabel: Self.inboxLabel(kind), time: WireFormat.time(n["createdAt"]?.string),
                needsYou: waiting, read: n["readAt"]?.string != nil, route: n["route"]?.string,
                needsYouID: kind == "approval" ? n["approvalId"]?.string : nil,
                message: Self.noticeKeys(n["message"]), actions: Self.noticeActions(n, kind: kind))
        }
        return InboxPage(items: items, nextCursor: result["nextCursor"]?.string)
    }

    public func resolveNotice(id: String, actionID: String) async throws {
        // The same call the web inbox makes for a notice's own button. Repeated taps reuse one key.
        _ = try await call(
            "notifications.resolve", .obj(["notificationId": .string(id), "actionId": .string(actionID)]),
            key: "resolve-\(id)-\(actionID)")
    }

    public func markRead(ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        // Mark-read is idempotent and waits in the outbox when the phone is away.
        let entry = OutboxEntry(
            id: "markread-\(UUID().uuidString)", kind: .markRead, method: "notifications.markRead",
            params: .obj(["notificationIds": .array(ids.map { .string($0) })]))
        // A rejection (the Gateway refused it for good) is the caller's to show; `.queued` waits for the Mac.
        if case .rejected(let why) = await client.submit(entry) { throw BackendError.refused(why) }
    }

    // MARK: - Pieces of the Home snapshot

    func needsYouApprovals() async throws -> [NeedsYouItem] {
        let result = try await call("approvals.list", .obj(["status": .array(["pending"]), "limit": .number(30)]))
        // The Gateway lists this phone's own tokens by approval id. An older one that sends none is trusted to
        // refuse at answer time instead.
        let tokens = result["answerTokens"]?.object
        return (result["approvals"]?.array ?? []).compactMap { a in
            let holds = tokens.map { t in a["id"]?.string.flatMap { t[$0]?.string } != nil } ?? true
            return Self.needsYou(approval: a, holdsAnswer: holds)
        }
    }

    func needsYouQuestions() async throws -> [NeedsYouItem] {
        let result = try await call("questions.list", .obj(["limit": .number(30)]))
        return (result["inputRequests"]?.array ?? []).compactMap { request in
            guard let id = request["id"]?.string, request["status"]?.string != "answered" else { return nil }
            let title = request["questions"]?.array?.first?["question"]?.string.map(DisplaySafe.text) ?? String(localized: "Psyche has a question", bundle: .module)
            return NeedsYouItem(
                id: id, kind: .question, title: title, source: "Question",
                time: WireFormat.time(request["createdAt"]?.string), threadID: request["threadId"]?.string,
                question: Self.questionDetail(request))
        }
    }

    /// Every part of a question request, as the phone answers it: each part's header, prompt and options, in the
    /// order the request has them. nil when a part is missing its header or options, so the phone never shows a
    /// partial question.
    static func questionDetail(_ request: JSONValue) -> QuestionDetail? {
        guard let questions = request["questions"]?.array, !questions.isEmpty else { return nil }
        var parts: [QuestionDetail.Part] = []
        for question in questions {
            guard let header = question["header"]?.string, !header.isEmpty,
                  let prompt = question["question"]?.string,
                  let rawOptions = question["options"]?.array, !rawOptions.isEmpty
            else { return nil }
            let options: [QuestionDetail.Option] = rawOptions.enumerated().compactMap { index, option in
                guard let label = option["label"]?.string, !label.isEmpty else { return nil }
                // The desktop card drops a trailing "(recommended)" from the label it shows and sends back.
                let value = label.replacingOccurrences(of: #"\s*\(recommended\)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
                return QuestionDetail.Option(
                    id: "\(index)", label: DisplaySafe.text(value),
                    detail: option["description"]?.string.map(DisplaySafe.text), value: value)
            }
            guard options.count == rawOptions.count else { return nil }
            // The header keys the answer on the wire, so it stays exact; only the prompt is shown made safe.
            parts.append(QuestionDetail.Part(
                header: header, prompt: DisplaySafe.text(prompt), options: options,
                multiSelect: question["multiSelect"]?.bool == true))
        }
        return QuestionDetail(parts: parts)
    }

    func runningTasks() async throws -> [RunningTask] {
        let result = try await call("tasks.list", .obj(["status": .array(["running"]), "limit": .number(10)]))
        return (result["tasks"]?.array ?? []).compactMap(Self.running(task:))
    }

    func todayBrief() async throws -> [BriefItem] {
        let result = try await call("daily.followups.list", .obj(["status": .array(["open"])]))
        return (result["followups"]?.array ?? []).prefix(8).compactMap { item in
            guard let id = item["id"]?.string, let text = item["text"]?.string else { return nil }
            let source = Self.humanized(item["source"]?.string ?? "")
            return BriefItem(id: id, text: text, evidenceLabel: "Because", evidence: source.isEmpty ? [] : [source])
        }
    }

    // MARK: - Mapping

    /// `holdsAnswer`: whether the Gateway gave this phone an answer token for the card (`approvals.list`'s
    /// `answerTokens`). A card without one (its caller kept it on the Mac, a payment) can't be answered here.
    static func needsYou(approval a: JSONValue, holdsAnswer: Bool = true) -> NeedsYouItem? {
        guard let id = a["id"]?.string, a["status"]?.string == "pending" || a["status"] == nil else { return nil }
        let kind = a["kind"]?.string ?? "approval"
        let summary = a["summary"]?.string ?? Self.humanized(kind)
        let agent = a.at("requestedBy", "agent")?.string
        // Read in the app before Allow: a lock-screen banner or the Dynamic Island shows only the title. Nested
        // details (a command's params, a script's lines) are shown in full, never summarised: the tap approves
        // exactly this, so they are read in the app first too.
        let (fields, nested) = Self.detailFields(Self.localizingWithheld(a["details"]))
        let reviewInApp = a["deviceOnly"]?.bool == true || nested
        var evidence: [String] = []
        if let because = a.at("fromLesson", "because")?.string { evidence.append(String(localized: "Because you said: \(because)", bundle: .module)) }
        if a["taint"]?.bool == true { evidence.append(String(localized: "Based on content from outside Psyche", bundle: .module)) }
        // The phone has no presence key (companion §5), so it never asks for Face ID on a Gateway card: a payment,
        // a card it can't show in full, or one not sent to this phone (no answer token for it) is answered on the Mac.
        let payment = a["requiresAuthentication"]?.bool == true
        let needsMac = payment || !holdsAnswer || Self.detailsNeedMac(a["details"])
        // Deny needs the phone's own answer token too, and a payment is never answered from the phone.
        let canDeny = holdsAnswer && !payment
        // The lock screen shows only the title and source: it can't say which computer the action is for.
        let machineName = Self.machineName(a["machine"])
        let detail = ApprovalDetail(
            kindLabel: Self.humanized(kind), title: summary,
            summary: agent.map { String(localized: "Requested by \($0).", bundle: .module) } ?? String(localized: "Psyche is asking before it goes ahead.", bundle: .module),
            fields: fields, evidence: evidence, alsoSentTo: String(localized: "Also sent to your Mac", bundle: .module),
            presenceNote: nil, allowLabel: String(localized: "Allow once", bundle: .module),
            reviewInApp: reviewInApp || machineName != nil, needsMac: needsMac, canDeny: canDeny,
            machineName: machineName)
        return NeedsYouItem(
            id: id, kind: .approval, title: summary, source: agent ?? Self.humanized(kind),
            time: WireFormat.time(a["requestedAt"]?.string), approval: detail,
            threadID: a.at("requestedBy", "threadId")?.string, taskID: a.at("requestedBy", "taskId")?.string)
    }

    /// The longest scalar detail a lock-screen Approve may stand for unread.
    static let inlineScalarLimit = 200

    /// True when a scalar detail must be read in the app first: longer than `inlineScalarLimit`, or spanning
    /// lines (the Gateway's sanitizer turns every newline into ⏎).
    static func scalarNeedsReview(_ text: String) -> Bool {
        text.count > inlineScalarLimit || text.contains("⏎") || text.contains(where: \.isNewline)
    }

    /// The largest nested value (as pretty JSON, in characters) the phone draws. Past it the card stays on the Mac:
    /// a text too big for one layer can't be drawn in full, and the phone never approves what it can't show.
    static let nestedLimit = 20_000

    /// An array or object detail as pretty, sorted JSON, or nil when it is empty or null.
    static func nestedText(_ value: JSONValue) -> String? {
        switch value {
        case .array, .object:
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else {
                return nil
            }
            return text
        default: return nil
        }
    }

    /// True when a detail is too large to show in full on the phone: a nested value over `nestedLimit`, or one that
    /// won't encode. Such a card is answered on the Mac, where the whole thing can be read. Deny stays on the phone.
    static func detailsNeedMac(_ details: JSONValue?) -> Bool {
        for (_, value) in details?.object ?? [:] {
            switch value {
            case .array, .object:
                guard let text = nestedText(value), text.count <= nestedLimit else { return true }
            default: continue
            }
        }
        return false
    }

    /// Keys whose value is code or a command: shown in monospace (and so is everything under them).
    static let codeKeys: Set<String> = ["command", "cmd", "script", "code", "diff", "argv", "args"]

    /// Every field of an approval's details, as the desktop card lists them: top-level keys sorted, nested objects
    /// and arrays spread into indented rows, each leaf shown whole. Nothing is left out, so the owner sees every value
    /// the approval binds before the tap. `review` is true when a value must be read in the app first (a nested
    /// value, a long one, or one that spans lines).
    static func detailFields(_ details: JSONValue?) -> (fields: [ApprovalDetail.Field], review: Bool) {
        var fields: [ApprovalDetail.Field] = []
        var review = false
        // Each row's path is its position at every level (0/2/1), never the raw keys: a key can hold a "." or "/",
        // so keys alone could repeat (`{"a":{"b":1},"a.b":2}`), and a repeated id breaks the SwiftUI list.
        func add(key: String, value: JSONValue, depth: Int, path: String, monospaced: Bool) {
            let code = monospaced || codeKeys.contains(key)
            switch value {
            case .object(let object) where !object.isEmpty:
                review = true
                fields.append(.init(key: Self.humanized(key), value: "", depth: depth, path: path))
                for (position, child) in object.sorted(by: { $0.key < $1.key }).enumerated() {
                    add(key: child.key, value: child.value, depth: depth + 1, path: "\(path)/\(position)", monospaced: code)
                }
            case .array(let items) where !items.isEmpty:
                review = true
                fields.append(.init(key: Self.humanized(key), value: "", depth: depth, path: path))
                for (index, item) in items.enumerated() {
                    add(key: "\(index + 1)", value: item, depth: depth + 1, path: "\(path)/\(index)", monospaced: code)
                }
            default:
                let text = Self.scalarText(value)
                if Self.scalarNeedsReview(text) { review = true }
                fields.append(.init(key: Self.humanized(key), value: text, depth: depth, monospaced: code, path: path))
            }
        }
        for (position, entry) in (details?.object ?? [:]).sorted(by: { $0.key < $1.key }).enumerated() {
            add(key: entry.key, value: entry.value, depth: 0, path: "\(position)", monospaced: false)
        }
        return (fields, review)
    }

    /// A leaf value as the card shows it. Null reads "—" (as on the desktop), an empty object or array "{}" or "[]".
    static func scalarText(_ value: JSONValue) -> String {
        switch value {
        case .null: return "—"
        case .bool(let flag): return flag ? String(localized: "true", bundle: .module) : String(localized: "false", bundle: .module)
        case .number(let number):
            return number.rounded() == number && abs(number) < 1e15 ? String(Int(number)) : String(number)
        case .string(let text): return text.isEmpty ? "—" : text
        case .array: return "[]"
        case .object: return "{}"
        }
    }

    /// The computer an approval is for: `machine.name`, trimmed. nil when absent or blank (the action is on this Mac).
    static func machineName(_ machine: JSONValue?) -> String? {
        guard let name = machine?["name"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }

    static func running(task t: JSONValue) -> RunningTask? {
        guard let id = t["id"]?.string else { return nil }
        let checklist = t["checklist"]?.array ?? []
        let done = checklist.filter { $0["status"]?.string == "completed" }.count
        let current = checklist.first { $0["status"]?.string != "completed" }?["text"]?.string
        return RunningTask(
            id: id, title: t["title"]?.string ?? String(localized: "Working", bundle: .module), step: min(done + 1, max(checklist.count, 1)),
            stepCount: checklist.count, detail: current ?? t["goal"]?.string ?? "",
            elapsed: WireFormat.elapsed(since: t["createdAt"]?.string),
            startedAt: WireFormat.date(t["startedAt"]?.string) ?? WireFormat.date(t["createdAt"]?.string))
    }

    /// The message ids of a notice, when the Gateway sent both. Values are plain text: numbers become their digits.
    static func noticeKeys(_ message: JSONValue?) -> InboxNoticeKeys? {
        guard let titleKey = message?["titleKey"]?.string, let bodyKey = message?["bodyKey"]?.string else { return nil }
        var params: [String: String] = [:]
        for (name, value) in message?["params"]?.object ?? [:] {
            if let text = value.string ?? value.double.map({ $0.rounded() == $0 ? String(Int($0)) : String($0) }) {
                params[name] = text
            }
        }
        return InboxNoticeKeys(titleKey: titleKey, bodyKey: bodyKey, params: params)
    }

    /// A notice's own buttons, as the web inbox shows them. Approval and question buttons answer through their
    /// own calls, and a resolved notice has nothing left to tap.
    static func noticeActions(_ n: JSONValue, kind: String) -> [InboxAction] {
        guard kind != "approval", kind != "input_needed", n["resolvedAt"]?.string == nil else { return [] }
        return (n["actions"]?.array ?? []).compactMap { a in
            guard let id = a["id"]?.string, let label = a["label"]?.string else { return nil }
            return InboxAction(
                id: id, label: label, labelKey: a["labelKey"]?.string, destructive: a["destructive"]?.bool == true)
        }
    }

    static func inboxLabel(_ kind: String) -> String {
        switch kind {
        case "approval": "Approval"
        case "input_needed": "Question"
        case "task_done", "specialist_result": String(localized: "Done", bundle: .module)
        case "briefing": "Brief"
        case "task_failed": String(localized: "Failed", bundle: .module)
        case "reminder": "Reminder"
        default: "Update"
        }
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }.joined().uppercased()
        return letters.isEmpty ? "·" : letters
    }
}

