import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import struct PsycheProtocol.WireError
import Testing

@testable import PsycheClient

/// The run details screen's Gateway calls: `runs.steps` pages a run's steps by seq, `runs.frames` lists the
/// frames and `runs.frame` returns one image.
struct GatewayRunDetailsTests {
    @Test func aStepDecodesItsKindStatusLabelsAndTimes() throws {
        let step = try #require(GatewayBackend.runStepRow(.object([
            "id": "stp_1", "seq": .number(3), "kind": "tool", "status": "ok",
            "label": "Opening the site", "doneLabel": "Opened the site", "target": "example.com",
            "startedAt": "2030-01-01T09:00:01Z", "endedAt": "2030-01-01T09:00:04Z",
        ])))
        #expect(step.id == "stp_1" && step.seq == 3)
        #expect(step.kind == RunStepKindName.tool)
        #expect(step.status == TaskRunStep.Status.ok)
        #expect(step.title == "Opened the site")
        #expect(step.target == "example.com")
        #expect(step.startedAt != nil && step.endedAt != nil)
    }

    @Test func anUnknownKindKeepsItsPlaceAndAnEmptyTargetIsNil() throws {
        let step = try #require(GatewayBackend.runStepRow(.object([
            "id": "stp_2", "seq": .number(4), "kind": "hologram", "status": "running",
            "label": "Thinking", "target": "",
        ])))
        #expect(step.kind == nil)
        #expect(step.title == "Thinking")
        #expect(step.target == nil)
        #expect(step.endedAt == nil)
    }

    @Test func aStepWithoutAnIdOrSeqIsDropped() {
        #expect(GatewayBackend.runStepRow(.object(["seq": .number(1), "label": "No id"])) == nil)
        #expect(GatewayBackend.runStepRow(.object(["id": "stp_3", "label": "No seq"])) == nil)
    }

    @Test func pagesReadAfterSeqAndStopWhenNextSeqIsNull() async throws {
        // Page 2 repeats seq 2 (a step that landed between two pages): it must not show twice.
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("runs.steps") { req in
                let after = req.params?["afterSeq"]?.double
                guard req.params?["runId"]?.stringValue == "run_1" else {
                    return .failure(WireError(code: "not_found", message: "wrong run"))
                }
                if after == nil { return .success(page(seqs: [1, 2], next: 2)) }
                if after == 2 { return .success(page(seqs: [2, 3], next: 3)) }
                if after == 3 { return .success(page(seqs: [4], next: nil)) }
                return .failure(WireError(code: "invalid", message: "unexpected afterSeq"))
            }
        }
        var list = RunStepList()
        var after: Int?
        var calls = 0
        repeat {
            let next = try await backend.runSteps(runID: "run_1", afterSeq: after, limit: 2)
            list.append(next)
            after = list.nextSeq
            calls += 1
        } while list.hasMore && calls < 10
        #expect(list.steps.map { $0.seq } == [1, 2, 3, 4])
        #expect(Set(list.steps.map { $0.id }).count == 4)
        #expect(list.nextSeq == nil && !list.hasMore)
        #expect(calls == 3)
    }

    @Test func framesDecodeAndAnImageComesBackAsData() async throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("runs.frames") { _ in
                .success(.object(["frames": .array([
                    .object(["seq": .number(1), "at": "2030-01-01T09:00:02Z", "stepId": "stp_1", "width": .number(1280), "height": .number(800)]),
                    .object(["seq": .number(2), "at": "2030-01-01T09:00:05Z", "stepId": .null, "width": .number(1280), "height": .number(800), "expired": .bool(true)]),
                ])]))
            }
            g.on("runs.frame") { req in
                guard req.params?["seq"]?.double == 1 else {
                    return .failure(WireError(code: "not_found", message: "frame not found"))
                }
                return .success(.object(["mime": "image/jpeg", "dataBase64": .string(png.base64EncodedString())]))
            }
        }
        let frames = try await backend.runFrames(runID: "run_1")
        #expect(frames.map { $0.seq } == [1, 2])
        #expect(frames[0].stepID == "stp_1")
        #expect(frames[1].stepID == nil && frames[1].expired)
        #expect(try await backend.runFrameImage(runID: "run_1", seq: 1, size: .thumb) == png)
    }

    /// `runs.frame` requires `size: "thumb" | "full"` (packages/protocol/src/methods/runs.ts).
    @Test func aFrameRequestCarriesTheSizeTheProtocolRequires() async throws {
        let (backend, h) = try await GatewayBackendTests().live { g in
            g.on("runs.frame") { req in
                guard let size = req.params?["size"]?.string, ["thumb", "full"].contains(size) else {
                    return .failure(WireError(code: "invalid_params", message: "size is required"))
                }
                return .success(.object(["mime": "image/jpeg", "dataBase64": .string(Data([1]).base64EncodedString())]))
            }
        }
        _ = try await backend.runFrameImage(runID: "run_1", seq: 3, size: .thumb)
        _ = try await backend.runFrameImage(runID: "run_1", seq: 3, size: .full)
        let sent = h.gateway.received.filter { $0.method == "runs.frame" }
        #expect(sent.map { $0.params?["size"]?.string } == ["thumb", "full"])
        #expect(sent.allSatisfy { $0.params?["runId"]?.string == "run_1" && $0.params?["seq"]?.double == 3 })
    }
}

/// A `runs.steps` result with the given seqs and the seq the Gateway would page from next.
private func page(seqs: [Int], next: Int?) -> JSONValue {
    let steps: [JSONValue] = seqs.map { seq in
        JSONValue.object([
            "id": .string("stp_\(seq)"), "seq": .number(Double(seq)), "kind": "tool", "status": "ok",
            "label": .string("Step \(seq)"), "startedAt": "2030-01-01T09:00:01Z",
        ])
    }
    let nextValue: JSONValue = next.map { .number(Double($0)) } ?? .null
    return .object(["steps": .array(steps), "nextSeq": nextValue])
}
