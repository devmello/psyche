import Foundation
import PsycheHelperCore
import PsycheHelperPoints
import PsycheProtocol
import Testing

@Suite("points.* capabilities")
struct PointsCapabilitiesTests {
    private static let strings: JSONValue = .object([:])

    private func handler(_ name: String, busy: Bool = false, recording: Bool = false) throws -> any CapabilityHandler {
        let all = PointsCapabilities.make(isComputerBusy: { busy }, isRecording: { recording })
        return try #require(all.first { $0.spec.name == name })
    }

    private func ctx(_ capability: String, _ params: JSONValue) -> InvocationContext {
        InvocationContext(invocationId: "points-test-1", capability: capability, params: params, approvalId: nil, emit: { _ in })
    }

    private var sessionParams: JSONValue {
        let names = [
            "askInPsyche", "back", "copy", "followWindow", "hideNote", "letLook", "looksWrong", "menuBarTitle", "next", "payButton", "scrollTo",
            "selfFill", "selfFillPlain", "skip", "stepFormat", "stop", "stuck", "stuckBlocked", "stuckMissing", "stuckUnclear", "unknownValue", "visionBadge",
        ]
        var strings: [String: JSONValue] = [:]
        for n in names { strings[n] = .string(n) }
        return .object(["window": .string("1:0"), "strings": .object(strings)])
    }

    @Test func theGroupHasExactlyTheW3ToW5Capabilities() {
        let all = PointsCapabilities.make(isComputerBusy: { false }, isRecording: { false })
        #expect(all.map(\.spec.name).sorted() == ["points.end", "points.look", "points.session", "points.show", "points.windows"])
    }

    @Test func aLookForAnUnknownSessionIsNotFound() async throws {
        let h = try handler("points.look")
        do {
            _ = try await h.invoke(ctx("points.look", ["sessionId": "nope", "actionId": "act-1"]))
            Issue.record("expected not_found")
        } catch let e as CapabilityError { #expect(e.reason == "no_session") }
        #expect(h.spec.sideEffect == .read)
    }

    @Test func aBoxShowForAnUnknownSessionIsNotFoundAndATargetCanBeABox() async throws {
        let h = try handler("points.show")
        let params: JSONValue = [
            "sessionId": "nope", "target": ["box": ["x": 1, "y": 2, "width": 3, "height": 4], "imageSize": ["width": 100, "height": 50]],
            "kind": "fill", "note": "here", "step": ["n": 1, "of": 2],
        ]
        do {
            _ = try await h.invoke(ctx("points.show", params))
            Issue.record("expected not_found")
        } catch let e as CapabilityError { #expect(e.reason == "no_session") }
    }

    @Test func noPointsCapabilityIsASideEffectOrAcceptsAnAction() {
        let all = PointsCapabilities.make(isComputerBusy: { false }, isRecording: { false })
        for h in all {
            #expect(h.spec.sideEffect == .read || h.spec.sideEffect == .none, "\(h.spec.name)")
            let schema = String(describing: h.spec.inputSchema).lowercased()
            for word in ["click", "keystroke", "axpress", "performaction", "setvalue", "point\":", "keycode"] {
                #expect(!schema.contains(word), "\(h.spec.name) schema mentions \(word)")
            }
        }
        #expect(all.first { $0.spec.name == "points.session" }?.spec.streaming == true)
    }

    @Test func aSessionWaitsWhileComputerUseHoldsTheLock() async throws {
        let h = try handler("points.session", busy: true)
        do {
            _ = try await h.invoke(ctx("points.session", sessionParams))
            Issue.record("must refuse")
        } catch let e as CapabilityError {
            #expect(e.reason == "computer_busy" && e.code == .conflict)
        }
    }

    @Test func aSessionWaitsWhileARecordingRuns() async throws {
        let h = try handler("points.session", recording: true)
        do {
            _ = try await h.invoke(ctx("points.session", sessionParams))
            Issue.record("must refuse")
        } catch let e as CapabilityError {
            #expect(e.reason == "recording_active" && e.code == .conflict)
        }
    }

    @Test func aBadWindowRefIsRefusedBeforeAnythingIsRead() async throws {
        let h = try handler("points.session")
        var params = sessionParams
        for bad in ["", "abc", "1", "1:2:3", "-4:0", "0:0", "12:-1"] {
            if case .object(var o) = params { o["window"] = .string(bad); params = .object(o) }
            do {
                _ = try await h.invoke(ctx("points.session", params))
                Issue.record("\(bad) must be refused")
            } catch let e as CapabilityError {
                #expect(e.code == .invalidParams, "\(bad)")
            }
        }
    }

    @Test func endIsIdempotentForAnUnknownSession() async throws {
        let h = try handler("points.end")
        let out = try await h.invoke(ctx("points.end", ["sessionId": "nope"]))
        #expect(out.result == .object([:]))
    }
}
