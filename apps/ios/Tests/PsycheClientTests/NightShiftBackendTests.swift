import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// Night shift's wire mapping and its answer path (docs/design/night-shift-2026.md §3.3, §5.2), against W5's contract:
///  1. only the Gateway's item data is drawn (preview rows, withheld items, text made plain and safe);
///  2. before `approvals.answer`, the approval's `details.items[]` must be exactly what was ticked: the draft rows by
///     `itemId` and `bindingHash`, the `<itemId>:send` rows by `itemId` and `send.to`;
///  7. an approval whose details need the Mac is never answered from the phone.
struct NightShiftBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    // MARK: Fixtures in the shapes the Gateway sends

    static func row(_ label: String, _ value: String, truncated: Bool = false, badge: String? = nil) -> JSONValue {
        var row: [String: JSONValue] = ["label": .string(label), "value": .string(value)]
        if truncated { row["truncated"] = .bool(true) }
        if let badge { row["badge"] = .string(badge) }
        return .object(row)
    }

    static func preview(_ rows: [JSONValue], truncated: Bool = false, kind: String = "mail") -> JSONValue {
        .object(["kind": .string(kind), "title": .string("Draft a reply"), "rows": .array(rows), "truncated": .bool(truncated)])
    }

    static func item(
        id: String, domain: String = "mail", status: String = "ready", tool: String = "mail_draft", hash: String? = nil,
        summary: String = "Reply to Dana", preview: JSONValue = .null, params: JSONValue = .null, send: JSONValue = .null,
        taint: Bool = false, withheld: Bool = false, approvalId: JSONValue = .null, result: JSONValue = .null,
        inverse: JSONValue = .null, appliedAt: JSONValue = .null
    ) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(id), "nightId": .string("n1"), "forkBranchId": .null, "seq": .number(0), "domain": .string(domain),
            "targetKey": .string("t-\(id)"), "tool": .string(tool), "kind": .string("write"),
            "sideEffect": .string("write"), "target": .null, "params": params, "paramsHash": .string("p-\(id)"),
            "bindingHash": .string(hash ?? "h-\(id)"), "summary": .string(summary), "preview": preview, "why": .null,
            "precondition": .null, "inverse": inverse, "send": send, "taint": .bool(taint), "taintSources": .array([]),
            "status": .string(status), "result": result, "approvalId": approvalId, "taskId": .null, "toolCallId": .null,
            "appliedAt": appliedAt, "createdAt": .string("2030-01-01T05:00:00Z"), "updatedAt": .string("2030-01-01T05:00:00Z"),
        ]
        if withheld { object["withheld"] = .string("messages") }
        return .object(object)
    }

    /// `details.items[]` as the broker writes it: draft rows by item id, send rows as `<itemId>:send` with `send.to`.
    static func entry(_ id: String, hash: String, to: [String]? = nil, withheld: Bool = false, noSendTo: Bool = false) -> JSONValue {
        var entry: [String: JSONValue] = [
            "itemId": .string(id), "tool": .string("mail_draft"), "summary": .string("x"), "bindingHash": .string(hash),
        ]
        if withheld { entry["withheld"] = .string("messages") }
        if let to { entry["send"] = .object(noSendTo ? [:] : ["to": .array(to.map(JSONValue.string))]) }
        return .object(entry)
    }

    static func approval(
        _ entries: [JSONValue], kind: String = "staged_apply", requiresAuthentication: Bool = false, extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        var details: [String: JSONValue] = ["items": .array(entries)]
        for (key, value) in extra { details[key] = value }
        return .object([
            "id": .string("ap_1"), "kind": .string(kind), "status": .string("pending"),
            "requiresAuthentication": .bool(requiresAuthentication), "details": .object(details),
        ])
    }

    static func request(items: [(String, String)], sends: [(String, [String])] = []) -> NightShiftApplyRequest {
        NightShiftApplyRequest(
            reviewID: "n1", items: items.map { NightShiftTick(itemID: $0.0, hash: $0.1) },
            sends: sends.map { NightShiftTick(itemID: $0.0, hash: "c-\($0.0)", recipients: $0.1) })
    }

    /// A Gateway that answers `nightShift.apply` (and `.undo`) with the given approval, and records any `approvals.answer`.
    func applying(
        approval: JSONValue?, refused: [JSONValue] = [], token: String? = "tok_phone"
    ) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await live { g in
            for method in ["nightShift.apply", "nightShift.undo"] {
                g.on(method) { _ in
                    var result: [String: JSONValue] = ["refused": .array(refused)]
                    if let approval { result["approval"] = approval }
                    if let token { result["answerToken"] = .string(token) }
                    return .success(.object(result))
                }
            }
            g.on("approvals.answer") { _ in .success(.object(["ok": .bool(true)])) }
        }
    }

    func answers(_ h: GatewayClientTests.Harness) -> [JSONValue?] {
        h.gateway.received.filter { $0.method == "approvals.answer" }.map(\.params)
    }

    // MARK: 1. Only the server's item data, as plain text

    @Test func reviewMapsPreviewRowsInOrderAndDropsWhatItCannotDraw() async throws {
        let (backend, h) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01"), "expiresAt": .string("2030-01-04T05:00:00Z")]),
                "items": .array([
                    Self.item(id: "a", preview: Self.preview([
                        Self.row("Recipient", "dana@acme.example"), Self.row("Subject", "Re: Q3"), Self.row("Body", "Hi"),
                    ]), taint: true),
                    Self.item(id: "b", domain: "teleport"),
                    Self.item(id: "c", status: "from_the_future"),
                    .object(["id": .string("no_hash"), "domain": .string("mail")]),
                ]),
            ])) }
        }
        let review = try await backend.nightShiftReview(id: "n1")
        #expect(review.items.map(\.id) == ["a", "c"])
        #expect(review.items[0].untrusted)
        #expect(review.items[0].rows.map(\.label) == ["Recipient", "Subject", "Body"])
        #expect(review.items[0].rows.map(\.value) == ["dana@acme.example", "Re: Q3", "Hi"])
        // The real expiry comes from the night, not from a guess.
        #expect(review.expiresAt == WireFormat.date("2030-01-04T05:00:00Z"))
        // An unknown status reads as stale: visible, never tickable.
        #expect(review.items[1].status == .stale)
        #expect(!review.items[1].canTick)
        #expect(h.gateway.received.last?.method == "nightShift.review.get")
    }

    @Test func textIsPlainAndHiddenCharactersAreMadeVisible() async throws {
        let body = "Click [here](https://evil.example) **now** <b>x</b>\u{202E}gnp.exe\u{85}next\r\nline2"
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([Self.item(
                    id: "a", summary: "Pay\u{2028}now \u{200B}",
                    preview: Self.preview([Self.row("Body", body), Self.row("Subj\u{202E}ect", "S\u{202E}x")]))]),
            ])) }
        }
        let item = try await backend.nightShiftReview(id: "n1").items[0]
        let text = item.rows[0].value
        // Markdown, HTML and a link are carried as the literal characters they are, never interpreted.
        #expect(text.contains("[here](https://evil.example) **now** <b>x</b>"))
        // The bidi override and NEL are shown, not obeyed.
        #expect(!text.contains("\u{202E}") && text.contains("⟨U+202E⟩"))
        #expect(!text.contains("\u{85}") && text.contains("next"))
        // Real line breaks in a body stay breaks; CRLF is one.
        #expect(text.hasSuffix("\nline2"))
        #expect(!item.summary.contains("\u{2028}") && !item.summary.contains("\u{200B}"))
        #expect(item.rows[1].label == "Subj⟨U+202E⟩ect" && item.rows[1].value == "S⟨U+202E⟩x")
    }

    @Test func badgesComeFromTheRowsAndTheDraftSendIsSeparate() async throws {
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([
                    Self.item(
                        id: "a",
                        preview: Self.preview([
                            Self.row("Reply all", "yes", badge: "reply_all"),
                            Self.row("Recipient", "sam@newco.example", badge: "new_recipient"),
                            Self.row("Body", "Hi", truncated: true),
                        ], truncated: true),
                        params: .object(["body": .string("Hi all, the whole text")]),
                        send: .object(["recipients": .array([.string("sam@newco.example")]), "contentHash": .string("c-a")])),
                    Self.item(id: "plain", preview: Self.preview([Self.row("Body", "Hi")])),
                ]),
            ])) }
        }
        let items = try await backend.nightShiftReview(id: "n1").items
        #expect(items[0].newRecipient && items[0].replyAll && items[0].truncated)
        #expect(items[0].rows[2].truncated)
        #expect(items[0].fullBody == "Hi all, the whole text")
        #expect(items[0].send == NightShiftSend(recipients: ["sam@newco.example"], contentHash: "c-a"))
        #expect(!items[1].newRecipient && !items[1].replyAll && items[1].send == nil)
    }

    @Test func aDraftTooLargeForThePhoneNeedsTheMacAndCarriesNoFullText() async throws {
        let huge = String(repeating: "x", count: GatewayBackend.nestedLimit + 1)
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([Self.item(id: "big", preview: Self.preview([Self.row("Body", "Hi")]), params: .object(["body": .string(huge)]))]),
            ])) }
        }
        let item = try await backend.nightShiftReview(id: "big").items[0]
        #expect(item.needsMac && item.fullBody == nil && !item.canTick)
    }

    // MARK: Withheld (Messages) items, applying state, results

    @Test func anItemFromMessagesArrivesWithheldAndCannotBeTicked() async throws {
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([Self.item(
                    id: "m", domain: "reminders", summary: "An item from your Messages. Open Psyche on this Mac to see it.",
                    preview: Self.preview([Self.row("Due", "Fri")], kind: "reminder"),
                    send: .object(["recipients": .array([.string("x@y.example")]), "contentHash": .string("c")]), withheld: true)]),
            ])) }
        }
        let item = try await backend.nightShiftReview(id: "n1").items[0]
        #expect(item.withheldMessages)
        // Nothing the Gateway sent for it is drawn, and it can't be ticked or sent from here.
        #expect(item.rows.isEmpty && item.send == nil && item.fullBody == nil && item.why == nil)
        #expect(!item.canTick)
        // Positive control: the same item without the flag draws its rows and ticks.
        let (other, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([Self.item(id: "m", domain: "reminders", preview: Self.preview([Self.row("Due", "Fri")], kind: "reminder"))]),
            ])) }
        }
        let plain = try await other.nightShiftReview(id: "n1").items[0]
        #expect(!plain.withheldMessages && plain.rows.count == 1 && plain.canTick)
    }

    @Test func anItemWithAnOpenApplyReadsAsApplyingAndCannotBeTicked() async throws {
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([
                    Self.item(id: "busy", approvalId: .string("ap_9")),
                    Self.item(id: "idle"),
                ]),
            ])) }
        }
        let items = try await backend.nightShiftReview(id: "n1").items
        #expect(items[0].applying && !items[0].canTick)
        #expect(!items[1].applying && items[1].canTick)
    }

    @Test func resultsReadSentUndoOfferAndErrors() async throws {
        let now = Date.now
        let recent = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3600))
        let old = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3 * 86_400))
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([
                    Self.item(id: "sent", status: "applied", result: .object(["refs": .array([.string("draft:1"), .string("sent:1")])])),
                    Self.item(id: "undoable", domain: "reminders", status: "applied", inverse: .object(["tool": .string("reminders_delete")]), appliedAt: .string(recent)),
                    Self.item(id: "toolate", domain: "reminders", status: "applied", inverse: .object(["tool": .string("reminders_delete")]), appliedAt: .string(old)),
                    Self.item(id: "noinverse", status: "applied", appliedAt: .string(recent)),
                    Self.item(id: "refused", domain: "reminders", status: "applied", result: .object(["error": .string("undo refused: the reminder changed")]), inverse: .object(["tool": .string("reminders_delete")]), appliedAt: .string(recent)),
                    Self.item(id: "nosend", status: "applied", result: .object(["error": .string("send before_effect: draft changed")])),
                ]),
            ])) }
        }
        let items = try await backend.nightShiftReview(id: "n1").items
        let byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        #expect(byID["sent"]?.sent == true && byID["undoable"]?.sent == false)
        #expect(byID["undoable"]?.canUndo == true)
        #expect(byID["toolate"]?.canUndo == false && byID["noinverse"]?.canUndo == false)
        #expect(byID["refused"]?.reason?.hasPrefix("undo refused:") == true && byID["refused"]?.status == .applied)
        #expect(byID["nosend"]?.reason?.hasPrefix("send before_effect:") == true)
    }

    @Test func aSendIsOfferedOnlyForANewAppleMailDraft() {
        let send = NightShiftSend(recipients: ["a@x.example"], contentHash: "c")
        for (tool, offered) in [
            ("mail_draft", true), ("mail_create_draft", true), ("mcp__apple__mail_draft", true),
            ("gmail_create_draft", false), ("mcp__google__gmail_create_draft", false), ("mail_reply_draft", false), ("files_move", false),
        ] {
            let item = NightShiftItem(id: "a", domain: .mail, tool: tool, summary: "s", bindingHash: "h", send: send)
            #expect(item.canOfferSend == offered, "\(tool)")
        }
        #expect(!NightShiftItem(id: "a", domain: .mail, tool: "mail_draft", summary: "s", bindingHash: "h").canOfferSend)
    }

    // MARK: 2. The answer check before approvals.answer

    @Test func theTapIsAnsweredOnlyWhenTheApprovalBindsExactlyWhatWasTicked() async throws {
        let (backend, h) = try await applying(approval: Self.approval([
            Self.entry("a", hash: "h-a"), Self.entry("a:send", hash: "broker-binding", to: ["Dana@acme.example"]), Self.entry("b", hash: "h-b"),
        ]))
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")], sends: [("a", ["dana@acme.example"])]))
        #expect(outcome == .answered(refused: []))
        let sent = h.gateway.received.first { $0.method == "nightShift.apply" }?.params
        #expect(sent?["reviewId"]?.string == "n1")
        #expect(sent?["items"]?.array?.compactMap { $0["bindingHash"]?.string } == ["h-a", "h-b"])
        #expect(sent?["sends"]?.array?.compactMap { $0["sendHash"]?.string } == ["c-a"])
        #expect(sent?["sends"]?.array?.compactMap { $0["itemId"]?.string } == ["a"])
        let answered = answers(h)
        #expect(answered.count == 1)
        #expect(answered[0]?["approvalId"]?.string == "ap_1" && answered[0]?["answerToken"]?.string == "tok_phone")
        #expect(answered[0]?["decision"]?.string == "approve" && answered[0]?["scope"]?.string == "once")
    }

    /// Each case is one way the approval can differ from the selection (a, b ticked, no send). Drafts are `id=hash`,
    /// sends are `id>recipient,recipient`.
    private static let differing: [(name: String, drafts: [String], sends: [String])] = [
        ("an extra call", ["a=h-a", "b=h-b", "evil=h-evil"], []),
        ("a missing call", ["a=h-a"], []),
        ("a changed hash", ["a=h-a", "b=h-b2"], []),
        ("a swapped item id", ["a=h-a", "c=h-b"], []),
        ("a repeated draft row", ["a=h-a", "a=h-a"], []),
        ("a send nobody ticked", ["a=h-a", "b=h-b"], ["a>dana@acme.example"]),
        ("a send to other people", ["a=h-a", "b=h-b"], ["a>eve@evil.example"]),
        ("an extra recipient on a send", ["a=h-a", "b=h-b"], ["a>dana@acme.example,eve@evil.example"]),
        ("a send without its draft row", ["b=h-b"], ["a>dana@acme.example"]),
        ("no calls at all", [], []),
    ]

    @Test func anApprovalThatDiffersFromTheSelectionIsNeverAnswered() async throws {
        for found in Self.differing {
            var rows: [JSONValue] = found.drafts.map { draft in
                let parts = draft.split(separator: "=").map(String.init)
                return Self.entry(parts[0], hash: parts[1])
            }
            for send in found.sends {
                let parts = send.split(separator: ">").map(String.init)
                rows.append(Self.entry("\(parts[0]):send", hash: "bb", to: parts[1].split(separator: ",").map(String.init)))
            }
            let (backend, h) = try await applying(approval: Self.approval(rows))
            await #expect(throws: NightShiftApplyError.mismatch, "\(found.name)") {
                _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")]))
            }
            #expect(answers(h).isEmpty, "\(found.name): nothing may reach approvals.answer")
        }
    }

    @Test func aTickedSendMissingFromTheApprovalIsAMismatchToo() async throws {
        let (backend, h) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-a")]))
        await #expect(throws: NightShiftApplyError.mismatch) {
            _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a")], sends: [("a", ["dana@acme.example"])]))
        }
        #expect(answers(h).isEmpty)
    }

    @Test func aSendRowWithoutItsRecipientsOrMarkedWithheldIsNeverAnswered() async throws {
        for rows in [
            [Self.entry("a", hash: "h-a"), Self.entry("a:send", hash: "bb", to: [], noSendTo: true)],
            [Self.entry("a", hash: "h-a", withheld: true)],
            [Self.entry("a", hash: "h-a"), Self.entry("a:send", hash: "bb", to: ["dana@acme.example"], withheld: true)],
        ] {
            let (backend, h) = try await applying(approval: Self.approval(rows))
            await #expect(throws: NightShiftApplyError.mismatch) {
                _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a")], sends: [("a", ["dana@acme.example"])]))
            }
            #expect(answers(h).isEmpty)
        }
    }

    @Test func anApprovalOfAnotherKindOrWithoutAnItemListIsNeverAnswered() async throws {
        for approval in [
            Self.approval([Self.entry("a", hash: "h-a")], kind: "write"),
            .object(["id": .string("ap_1"), "kind": .string("staged_apply"), "status": .string("pending"), "details": .object([:])]),
            .object(["id": .string("ap_1"), "kind": .string("staged_apply"), "status": .string("pending"), "details": .object(["items": .array([.object(["summary": .string("no hash")])])])]),
        ] {
            let (backend, h) = try await applying(approval: approval)
            await #expect(throws: NightShiftApplyError.mismatch) {
                _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a")]))
            }
            #expect(answers(h).isEmpty)
        }
    }

    @Test func itemsTheGatewayRefusedMayBeAbsentAndAreReported() async throws {
        let refused: [JSONValue] = [.object(["itemId": .string("b"), "reason": .string("The event changed.")])]
        let (backend, h) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-a")]), refused: refused)
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")]))
        #expect(outcome == .answered(refused: [NightShiftRefusal(itemID: "b", reason: "The event changed.")]))
        #expect(answers(h).count == 1)
        // A Gateway that drops an item without saying so is a mismatch.
        let (silent, h2) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-a")]))
        await #expect(throws: NightShiftApplyError.mismatch) {
            _ = try await silent.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")]))
        }
        #expect(answers(h2).isEmpty)
    }

    @Test func aRefusedSendLeavesTheDraftApprovedAndNothingElse() async throws {
        // Gmail drafts can't be sent: the refusal names the draft's id, the draft still applies, and its send row is absent.
        let refused: [JSONValue] = [.object(["itemId": .string("a"), "reason": .string("Gmail drafts can't be read back")])]
        let (backend, h) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-a")]), refused: refused)
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a")], sends: [("a", ["dana@acme.example"])]))
        #expect(outcome == .answered(refused: [NightShiftRefusal(itemID: "a", reason: "Gmail drafts can't be read back")]))
        #expect(answers(h).count == 1)
        // But a send row the owner did not tick still fails, refusal or not.
        let (other, h2) = try await applying(
            approval: Self.approval([Self.entry("a", hash: "h-a"), Self.entry("a:send", hash: "bb", to: ["eve@evil.example"])]), refused: refused)
        await #expect(throws: NightShiftApplyError.mismatch) {
            _ = try await other.applyNightShift(Self.request(items: [("a", "h-a")], sends: [("a", ["dana@acme.example"])]))
        }
        #expect(answers(h2).isEmpty)
    }

    @Test func whenEverythingIsRefusedThereIsNothingToAnswer() async throws {
        let refused: [JSONValue] = [.object(["itemId": .string("a"), "reason": .string("Stale.")])]
        let (backend, h) = try await applying(approval: nil, refused: refused)
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a")]))
        #expect(outcome == .nothingApproved(refused: [NightShiftRefusal(itemID: "a", reason: "Stale.")]))
        #expect(answers(h).isEmpty)
    }

    @Test func applyingNothingIsRefusedBeforeAnyCall() async throws {
        let (backend, h) = try await applying(approval: Self.approval([]))
        await #expect(throws: BackendError.self) { _ = try await backend.applyNightShift(Self.request(items: [])) }
        #expect(h.gateway.received.filter { $0.method == "nightShift.apply" }.isEmpty)
    }

    // MARK: Undo

    @Test func anUndoIsAnsweredOnlyWhenTheApprovalListsExactlyTheItemsAsked() async throws {
        let (backend, h) = try await applying(approval: Self.approval([Self.entry("a", hash: "inv-a"), Self.entry("b", hash: "inv-b")]))
        #expect(try await backend.undoNightShift(itemIDs: ["a", "b"]) == .answered(refused: []))
        let sent = h.gateway.received.first { $0.method == "nightShift.undo" }?.params
        #expect(sent?["itemIds"]?.array?.compactMap(\.string) == ["a", "b"])
        #expect(answers(h).count == 1)
        for rows in [
            [Self.entry("a", hash: "x")],
            [Self.entry("a", hash: "x"), Self.entry("b", hash: "x"), Self.entry("evil", hash: "x")],
            [Self.entry("a", hash: "x"), Self.entry("b", hash: "x"), Self.entry("b:send", hash: "x", to: ["e@x.example"])],
            [Self.entry("a", hash: "x"), Self.entry("b", hash: "x", withheld: true)],
        ] {
            let (other, h2) = try await applying(approval: Self.approval(rows))
            await #expect(throws: NightShiftApplyError.mismatch) { _ = try await other.undoNightShift(itemIDs: ["a", "b"]) }
            #expect(answers(h2).isEmpty)
        }
    }

    // MARK: 7. Details that need the Mac

    @Test func detailsTooLargeForThePhoneSendTheOwnerToTheMacAndNothingIsAnswered() async throws {
        let huge = String(repeating: "x", count: GatewayBackend.nestedLimit + 1)
        let (backend, h) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-a")], extra: ["note": .object(["text": .string(huge)])]))
        #expect(try await backend.applyNightShift(Self.request(items: [("a", "h-a")])) == .needsMac(refused: []))
        #expect(answers(h).isEmpty)
    }

    @Test func aPaymentOrAMissingTokenIsNeverAnsweredFromThePhone() async throws {
        let (pay, h1) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-a")], requiresAuthentication: true))
        #expect(try await pay.applyNightShift(Self.request(items: [("a", "h-a")])) == .needsMac(refused: []))
        #expect(answers(h1).isEmpty)
        let (noToken, h2) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-a")]), token: nil)
        #expect(try await noToken.applyNightShift(Self.request(items: [("a", "h-a")])) == .needsMac(refused: []))
        #expect(answers(h2).isEmpty)
    }

    @Test func theMismatchIsCheckedBeforeTheMacHandoff() async throws {
        let huge = String(repeating: "x", count: GatewayBackend.nestedLimit + 1)
        let (backend, h) = try await applying(approval: Self.approval([Self.entry("a", hash: "h-evil")], extra: ["note": .object(["text": .string(huge)])]))
        await #expect(throws: NightShiftApplyError.mismatch) {
            _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a")]))
        }
        #expect(answers(h).isEmpty)
    }

    // MARK: The card the phone shows for a withheld row

    @Test func aWithheldRowOnTheApprovalCardReadsInTheAppsLanguageAndNamesNothing() {
        let details: JSONValue = .object([
            "items": .array([
                Self.entry("m", hash: "h", withheld: true),
                .object(["itemId": .string("a"), "summary": .string("Reply to Dana"), "bindingHash": .string("h-a")]),
            ]),
        ])
        let shown = GatewayBackend.localizingWithheld(details)
        let rows = shown?["items"]?.array ?? []
        #expect(rows[0]["summary"]?.string == GatewayBackend.withheldMessagesLine)
        #expect(rows[0]["withheld"]?.string == "messages")
        // Control: a row that isn't withheld keeps the Gateway's summary.
        #expect(rows[1]["summary"]?.string == "Reply to Dana")
    }

    // MARK: Status and dismiss

    @Test func statusReadsCountsAndTheReadyReview() async throws {
        let (backend, _) = try await live { g in
            g.on("nightShift.status") { _ in .success(.object([
                "enabled": .bool(true), "nextWindowAt": .null, "readyReviewId": .string("n1"),
                "latest": .object([
                    "id": .string("n1"), "night": .string("2030-01-01"), "status": .string("done"), "reviewStatus": .string("ready"),
                    "counts": .object(["mail": .number(3), "calendar": .number(2), "reminders": .number(0), "files": .number(1)]),
                    "expiresAt": .string("2030-01-04T05:00:00Z"),
                ]),
            ])) }
        }
        let status = try await backend.nightShiftStatus()
        #expect(status.enabled && status.readyReviewID == "n1")
        #expect(status.counts == NightShiftCounts(mail: 3, calendar: 2, reminders: 0, files: 1))
        #expect(status.counts.total == 6)
        #expect(status.expiresAt == WireFormat.date("2030-01-04T05:00:00Z"))
    }

    @Test func dismissingSendsTheItemIdsItIsGiven() async throws {
        let (backend, h) = try await live { g in
            g.on("nightShift.dismiss") { _ in .success(.object(["dismissed": .number(2)])) }
        }
        try await backend.dismissNightShift(reviewID: "n1", itemIDs: nil)
        try await backend.dismissNightShift(reviewID: "n1", itemIDs: ["a"])
        let calls = h.gateway.received.filter { $0.method == "nightShift.dismiss" }
        #expect(calls[0].params?["itemIds"] == nil)
        #expect(calls[1].params?["itemIds"]?.array?.compactMap(\.string) == ["a"])
    }
}
