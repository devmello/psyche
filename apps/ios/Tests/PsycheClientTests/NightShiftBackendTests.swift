import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// Night shift's wire mapping and its answer path (docs/design/night-shift-2026.md §3.3, §5.2). The security rules the
/// reviews asked for are pinned here:
///  1. only the Gateway's item data is drawn (unknown shapes dropped, text made plain and safe);
///  2. before `approvals.answer`, the approval's `details.items[].bindingHash` set must equal exactly what was ticked;
///  7. an approval whose details need the Mac is never answered from the phone.
struct NightShiftBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    // MARK: Fixtures in the shapes the Gateway sends

    static func item(
        id: String, domain: String = "mail", status: String = "ready", hash: String? = nil, summary: String = "Reply to Dana",
        preview: JSONValue = .null, params: JSONValue = .null, send: JSONValue = .null, taint: Bool = false
    ) -> JSONValue {
        .object([
            "id": .string(id), "nightId": .string("n1"), "forkBranchId": .null, "seq": .number(0), "domain": .string(domain),
            "targetKey": .string("t-\(id)"), "tool": .string("mail_create_draft"), "kind": .string("write"),
            "sideEffect": .string("write"), "target": .null, "params": params, "paramsHash": .string("p-\(id)"),
            "bindingHash": .string(hash ?? "h-\(id)"), "summary": .string(summary), "preview": preview, "why": .null,
            "precondition": .null, "inverse": .null, "send": send, "taint": .bool(taint), "taintSources": .array([]),
            "status": .string(status), "result": .null, "approvalId": .null, "taskId": .null, "toolCallId": .null,
            "appliedAt": .null, "createdAt": .string("2030-01-01T05:00:00Z"), "updatedAt": .string("2030-01-01T05:00:00Z"),
        ])
    }

    static func approval(
        _ hashes: [String], kind: String = "staged_apply", requiresAuthentication: Bool = false, extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        var details: [String: JSONValue] = [
            "items": .array(hashes.map { .object(["bindingHash": .string($0), "summary": .string("x")]) }),
        ]
        for (key, value) in extra { details[key] = value }
        return .object([
            "id": .string("ap_1"), "kind": .string(kind), "status": .string("pending"),
            "requiresAuthentication": .bool(requiresAuthentication), "details": .object(details),
        ])
    }

    static func request(items: [(String, String)], sends: [(String, String)] = []) -> NightShiftApplyRequest {
        NightShiftApplyRequest(
            reviewID: "n1", items: items.map { NightShiftTick(itemID: $0.0, hash: $0.1) },
            sends: sends.map { NightShiftTick(itemID: $0.0, hash: $0.1) })
    }

    /// A Gateway that answers `nightShift.apply` with the given approval, and records any `approvals.answer`.
    func applying(
        approval: JSONValue?, refused: [JSONValue] = [], token: String? = "tok_phone"
    ) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await live { g in
            g.on("nightShift.apply") { _ in
                var result: [String: JSONValue] = ["refused": .array(refused)]
                if let approval { result["approval"] = approval }
                if let token { result["answerToken"] = .string(token) }
                return .success(.object(result))
            }
            g.on("approvals.answer") { _ in .success(.object(["ok": .bool(true)])) }
        }
    }

    func answered(_ h: GatewayClientTests.Harness) -> [WireCall] {
        h.gateway.received.filter { $0.method == "approvals.answer" }.map { WireCall(method: $0.method, params: $0.params) }
    }

    struct WireCall { var method: String; var params: JSONValue? }

    // MARK: 1. Only the server's item data, as plain text

    @Test func reviewMapsOnlyTheGatewaysFieldsAndDropsWhatItCannotDraw() async throws {
        let (backend, h) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01"), "expiresAt": .string("2030-01-04T05:00:00Z")]),
                "items": .array([
                    Self.item(id: "a", preview: .object(["to": .array([.string("dana@acme.example")]), "subject": .string("Re: Q3"), "body": .string("Hi")]), taint: true),
                    Self.item(id: "b", domain: "teleport"),
                    Self.item(id: "c", status: "from_the_future"),
                    .object(["id": .string("no_hash"), "domain": .string("mail")]),
                ]),
            ])) }
        }
        let review = try await backend.nightShiftReview(id: "n1")
        #expect(review.items.map(\.id) == ["a", "c"])
        #expect(review.items[0].untrusted)
        #expect(review.items[0].recipients == ["dana@acme.example"])
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
                    id: "a", summary: "Pay\u{2028}now \u{200B}", preview: .object(["body": .string(body), "subject": .string("S\u{202E}x")]))]),
            ])) }
        }
        let item = try await backend.nightShiftReview(id: "n1").items[0]
        // Markdown, HTML and a link are carried as the literal characters they are, never interpreted.
        #expect(item.body?.contains("[here](https://evil.example) **now** <b>x</b>") == true)
        // The bidi override and NEL are shown, not obeyed.
        #expect(item.body?.contains("\u{202E}") == false)
        #expect(item.body?.contains("⟨U+202E⟩") == true)
        #expect(item.body?.contains("\u{85}") == false)
        #expect(item.body?.contains("next") == true)
        // Real line breaks in a body stay breaks; CRLF is one.
        #expect(item.body?.hasSuffix("\nline2") == true)
        #expect(item.summary.contains("\u{2028}") == false)
        #expect(item.summary.contains("\u{200B}") == false)
        #expect(item.subject == "S⟨U+202E⟩x")
    }

    @Test func markersComeFromTheGatewaysPreviewAndTheDraftSendIsSeparate() async throws {
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([
                    Self.item(
                        id: "a", preview: .object(["newRecipients": .array([.string("sam@newco.example")]), "replyAll": .bool(true), "truncated": .bool(true), "body": .string("Hi")]),
                        params: .object(["body": .string("Hi all, the whole text")]),
                        send: .object(["recipients": .array([.string("sam@newco.example")]), "contentHash": .string("c-a")])),
                    Self.item(id: "plain", preview: .object(["body": .string("Hi")])),
                ]),
            ])) }
        }
        let items = try await backend.nightShiftReview(id: "n1").items
        #expect(items[0].newRecipient)
        #expect(items[0].replyAll)
        #expect(items[0].truncated)
        #expect(items[0].fullBody == "Hi all, the whole text")
        #expect(items[0].send == NightShiftSend(recipients: ["sam@newco.example"], contentHash: "c-a"))
        #expect(!items[1].newRecipient && !items[1].replyAll && items[1].send == nil)
    }

    @Test func aDraftTooLargeForThePhoneNeedsTheMacAndCarriesNoFullText() async throws {
        let huge = String(repeating: "x", count: GatewayBackend.nestedLimit + 1)
        let (backend, _) = try await live { g in
            g.on("nightShift.review.get") { _ in .success(.object([
                "night": .object(["id": .string("n1"), "night": .string("2030-01-01")]),
                "items": .array([Self.item(id: "big", preview: .object(["body": .string("Hi")]), params: .object(["body": .string(huge)]))]),
            ])) }
        }
        let item = try await backend.nightShiftReview(id: "big").items[0]
        #expect(item.needsMac)
        #expect(item.fullBody == nil)
        #expect(!item.canTick)
    }

    // MARK: 2. The hash check before approvals.answer

    @Test func theTapIsAnsweredOnlyWhenTheApprovalBindsExactlyWhatWasTicked() async throws {
        let (backend, h) = try await applying(approval: Self.approval(["h-a", "h-b", "c-a"]))
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")], sends: [("a", "c-a")]))
        #expect(outcome == .answered(refused: []))
        let sent = h.gateway.received.first { $0.method == "nightShift.apply" }?.params
        #expect(sent?["items"]?.array?.compactMap { $0["bindingHash"]?.string } == ["h-a", "h-b"])
        #expect(sent?["sends"]?.array?.compactMap { $0["sendHash"]?.string } == ["c-a"])
        let answers = answered(h)
        #expect(answers.count == 1)
        #expect(answers[0].params?["approvalId"]?.string == "ap_1")
        #expect(answers[0].params?["answerToken"]?.string == "tok_phone")
        #expect(answers[0].params?["decision"]?.string == "approve")
        #expect(answers[0].params?["scope"]?.string == "once")
    }

    @Test(arguments: [
        ("an extra call", ["h-a", "h-b", "h-evil"]),
        ("a missing call", ["h-a"]),
        ("a changed hash", ["h-a", "h-b2"]),
        ("a repeated hash", ["h-a", "h-a"]),
        ("a send the owner did not tick", ["h-a", "h-b", "c-a"]),
        ("no calls at all", []),
    ])
    func anApprovalThatDiffersFromTheSelectionIsNeverAnswered(_ name: String, _ hashes: [String]) async throws {
        let (backend, h) = try await applying(approval: Self.approval(hashes))
        await #expect(throws: NightShiftApplyError.mismatch, "\(name)") {
            _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")]))
        }
        #expect(answered(h).isEmpty, "\(name): nothing may reach approvals.answer")
    }

    @Test func aTickedSendMissingFromTheApprovalIsAMismatchToo() async throws {
        let (backend, h) = try await applying(approval: Self.approval(["h-a"]))
        await #expect(throws: NightShiftApplyError.mismatch) {
            _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a")], sends: [("a", "c-a")]))
        }
        #expect(answered(h).isEmpty)
    }

    @Test func anApprovalOfAnotherKindOrWithoutAnItemListIsNeverAnswered() async throws {
        for approval in [
            Self.approval(["h-a"], kind: "write"),
            .object(["id": .string("ap_1"), "kind": .string("staged_apply"), "status": .string("pending"), "details": .object([:])]),
            .object(["id": .string("ap_1"), "kind": .string("staged_apply"), "status": .string("pending"), "details": .object(["items": .array([.object(["summary": .string("no hash")])])])]),
        ] {
            let (backend, h) = try await applying(approval: approval)
            await #expect(throws: NightShiftApplyError.mismatch) {
                _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a")]))
            }
            #expect(answered(h).isEmpty)
        }
    }

    @Test func itemsTheGatewayRefusedLeaveTheExpectedSetAndAreReported() async throws {
        let refused: [JSONValue] = [.object(["itemId": .string("b"), "reason": .string("The event changed.")])]
        // The approval binds only what the Gateway kept: a, and the send of a.
        let (backend, h) = try await applying(approval: Self.approval(["h-a", "c-a"]), refused: refused)
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")], sends: [("a", "c-a")]))
        #expect(outcome == .answered(refused: [NightShiftRefusal(itemID: "b", reason: "The event changed.")]))
        #expect(answered(h).count == 1)
        // A Gateway that drops an item without saying so is a mismatch.
        let (silent, h2) = try await applying(approval: Self.approval(["h-a"]))
        await #expect(throws: NightShiftApplyError.mismatch) {
            _ = try await silent.applyNightShift(Self.request(items: [("a", "h-a"), ("b", "h-b")]))
        }
        #expect(answered(h2).isEmpty)
    }

    @Test func whenEverythingIsRefusedThereIsNothingToAnswer() async throws {
        let refused: [JSONValue] = [.object(["itemId": .string("a"), "reason": .string("Stale.")])]
        let (backend, h) = try await applying(approval: nil, refused: refused)
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a")]))
        #expect(outcome == .nothingApproved(refused: [NightShiftRefusal(itemID: "a", reason: "Stale.")]))
        #expect(answered(h).isEmpty)
    }

    @Test func applyingNothingIsRefusedBeforeAnyCall() async throws {
        let (backend, h) = try await applying(approval: Self.approval([]))
        await #expect(throws: BackendError.self) { _ = try await backend.applyNightShift(Self.request(items: [])) }
        #expect(h.gateway.received.filter { $0.method == "nightShift.apply" }.isEmpty)
    }

    // MARK: 7. Details that need the Mac

    @Test func detailsTooLargeForThePhoneSendTheOwnerToTheMacAndNothingIsAnswered() async throws {
        let huge = String(repeating: "x", count: GatewayBackend.nestedLimit + 1)
        let (backend, h) = try await applying(approval: Self.approval(["h-a"], extra: ["note": .object(["text": .string(huge)])]))
        let outcome = try await backend.applyNightShift(Self.request(items: [("a", "h-a")]))
        #expect(outcome == .needsMac(refused: []))
        #expect(answered(h).isEmpty)
    }

    @Test func aPaymentOrAMissingTokenIsNeverAnsweredFromThePhone() async throws {
        let (pay, h1) = try await applying(approval: Self.approval(["h-a"], requiresAuthentication: true))
        #expect(try await pay.applyNightShift(Self.request(items: [("a", "h-a")])) == .needsMac(refused: []))
        #expect(answered(h1).isEmpty)
        let (noToken, h2) = try await applying(approval: Self.approval(["h-a"]), token: nil)
        #expect(try await noToken.applyNightShift(Self.request(items: [("a", "h-a")])) == .needsMac(refused: []))
        #expect(answered(h2).isEmpty)
    }

    @Test func theMismatchIsCheckedBeforeTheMacHandoff() async throws {
        // Even an approval that would go to the Mac must bind what was ticked: a mismatch is an error, not a handoff.
        let huge = String(repeating: "x", count: GatewayBackend.nestedLimit + 1)
        let (backend, h) = try await applying(approval: Self.approval(["h-evil"], extra: ["note": .object(["text": .string(huge)])]))
        await #expect(throws: NightShiftApplyError.mismatch) {
            _ = try await backend.applyNightShift(Self.request(items: [("a", "h-a")]))
        }
        #expect(answered(h).isEmpty)
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
        #expect(status.enabled)
        #expect(status.readyReviewID == "n1")
        #expect(status.counts == NightShiftCounts(mail: 3, calendar: 2, reminders: 0, files: 1))
        #expect(status.counts.total == 6)
    }

    @Test func dismissingTheRestSendsNoItemIds() async throws {
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
