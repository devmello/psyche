import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

extension GatewayBackend {
    public func home() async throws -> HomeSnapshot {
        // Approvals and questions are the screen; the rest degrade to empty sections.
        async let approvals = settled { try await self.needsYouApprovals() }
        async let questions = settled { try await self.needsYouQuestions() }
        async let tasks = optional { try await self.runningTasks() }
        async let brief = optional { try await self.todayBrief() }
        async let nudges = optional { try await self.nudgeList() }
        let (a, q) = await (approvals, questions)
        if case .failure(let error) = a, case .failure = q { throw error }
        let needsYou = ((try? a.get()) ?? []) + ((try? q.get()) ?? [])
        return await HomeSnapshot(
            needsYou: needsYou,
            running: tasks ?? [], today: brief ?? [], keepInTouch: nudges ?? [], updatedAt: .now)
    }

    public func answerApproval(id: String, decision: ApprovalDecision) async throws {
        let current = try await call("approvals.get", .obj(["approvalId": .string(id)]))
        guard let approval = current["approval"] else { throw BackendError.notFound }
        if approval["status"]?.string != "pending" { throw BackendError.refused("That approval is no longer waiting.") }
        // Device-only and presence-gated approvals need a presence assertion from a registered Secure Enclave
        // key (companion §5); the phone has none yet, so these stay on the Mac rather than failing late.
        if approval["deviceOnly"]?.bool == true || approval["requiresAuthentication"]?.bool == true {
            throw BackendError.refused("This one needs your Mac. Answer it there.")
        }
        guard let token = current["answerToken"]?.string else {
            throw BackendError.refused("This approval was sent to a different device.")
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
        guard let request = current["inputRequest"], let questions = request["questions"]?.array, let first = questions.first,
              let header = first["header"]?.string else { throw BackendError.notFound }
        guard questions.count == 1 else { throw BackendError.refused("This question has several parts. Answer it on your Mac.") }
        guard let value = answer.optionID ?? answer.text, !value.isEmpty else { throw BackendError.refused("Choose an answer first.") }
        _ = try await call(
            "questions.answer", .obj(["inputRequestId": .string(id), "answer": .object([header: .string(value)])]),
            key: "answer-\(id)")
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
        let result = try await call("notifications.list", .obj(["limit": .number(50)]))
        return (result["notifications"]?.array ?? []).compactMap { n in
            guard let id = n["id"]?.string else { return nil }
            let kind = n["kind"]?.string ?? "system"
            let waiting = (kind == "approval" || kind == "input_needed") && n["resolvedAt"]?.string == nil
            return InboxItem(
                id: id, title: n["title"]?.string ?? "", body: n["body"]?.string ?? "",
                kindLabel: Self.inboxLabel(kind), time: WireFormat.time(n["createdAt"]?.string),
                needsYou: waiting, read: n["readAt"]?.string != nil, route: n["route"]?.string)
        }
    }

    public func markRead(ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        // Mark-read is idempotent and waits in the outbox when the phone is away.
        let entry = OutboxEntry(
            id: "markread-\(UUID().uuidString)", kind: .markRead, method: "notifications.markRead",
            params: .obj(["notificationIds": .array(ids.map { .string($0) })]))
        _ = await client.submit(entry)
    }

    // MARK: - Pieces of the Home snapshot

    func needsYouApprovals() async throws -> [NeedsYouItem] {
        let result = try await call("approvals.list", .obj(["status": .array(["pending"]), "limit": .number(30)]))
        return (result["approvals"]?.array ?? []).compactMap(Self.needsYou(approval:))
    }

    func needsYouQuestions() async throws -> [NeedsYouItem] {
        let result = try await call("questions.list", .obj(["limit": .number(30)]))
        return (result["inputRequests"]?.array ?? []).compactMap { request in
            guard let id = request["id"]?.string, request["status"]?.string != "answered" else { return nil }
            let title = request["questions"]?.array?.first?["question"]?.string ?? "Psyche has a question"
            return NeedsYouItem(
                id: id, kind: .question, title: title, source: "Question",
                time: WireFormat.time(request["createdAt"]?.string), threadID: request["threadId"]?.string)
        }
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

    func nudgeList() async throws -> [Nudge] {
        let result = try await call("nudges.list", .obj([:]))
        guard result["enabled"]?.bool == true else { return [] }
        return (result["items"]?.array ?? []).compactMap { item in
            guard let id = item["id"]?.string, let text = item["text"]?.string else { return nil }
            return Nudge(id: id, initials: Self.initials(item["name"]?.string ?? ""), text: text)
        }
    }

    // MARK: - Mapping

    static func needsYou(approval a: JSONValue) -> NeedsYouItem? {
        guard let id = a["id"]?.string, a["status"]?.string == "pending" || a["status"] == nil else { return nil }
        let kind = a["kind"]?.string ?? "approval"
        let summary = a["summary"]?.string ?? Self.humanized(kind)
        let agent = a.at("requestedBy", "agent")?.string
        var fields: [ApprovalDetail.Field] = []
        for (key, value) in (a["details"]?.object ?? [:]).sorted(by: { $0.key < $1.key }) {
            if let text = value.string ?? value.double.map({ String($0) }) ?? value.bool.map({ String($0) }) {
                fields.append(.init(key: Self.humanized(key), value: text))
            }
        }
        var evidence: [String] = []
        if let because = a.at("fromLesson", "because")?.string { evidence.append("Because you said: \(because)") }
        if a["taint"]?.bool == true { evidence.append("Based on content from outside Psyche") }
        let needsMac = a["deviceOnly"]?.bool == true || a["requiresAuthentication"]?.bool == true
        let detail = ApprovalDetail(
            kindLabel: Self.humanized(kind), title: summary,
            summary: agent.map { "Requested by \($0)." } ?? "Psyche is asking before it goes ahead.",
            fields: fields, evidence: evidence, alsoSentTo: "Also sent to your Mac",
            presenceNote: needsMac ? "This one needs your Mac." : nil, allowLabel: "Allow once")
        return NeedsYouItem(
            id: id, kind: .approval, title: summary, source: agent ?? Self.humanized(kind),
            time: WireFormat.time(a["requestedAt"]?.string), approval: detail,
            threadID: a.at("requestedBy", "threadId")?.string)
    }

    static func running(task t: JSONValue) -> RunningTask? {
        guard let id = t["id"]?.string else { return nil }
        let checklist = t["checklist"]?.array ?? []
        let done = checklist.filter { $0["status"]?.string == "done" }.count
        let current = checklist.first { $0["status"]?.string != "done" }?["text"]?.string
        return RunningTask(
            id: id, title: t["title"]?.string ?? "Working", step: min(done + 1, max(checklist.count, 1)),
            stepCount: checklist.count, detail: current ?? t["goal"]?.string ?? "",
            elapsed: WireFormat.elapsed(since: t["createdAt"]?.string))
    }

    static func inboxLabel(_ kind: String) -> String {
        switch kind {
        case "approval": "Approval"
        case "input_needed": "Question"
        case "task_done", "specialist_result": "Done"
        case "briefing": "Brief"
        case "task_failed": "Failed"
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

