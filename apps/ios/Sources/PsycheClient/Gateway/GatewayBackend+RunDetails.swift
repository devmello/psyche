import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

/// The run details screen's Gateway calls: `runs.steps` pages a run's steps, `runs.frames` lists the frames
/// Psyche saw, and `runs.frame` returns one frame's JPEG. All three are read-only (`operator.read`). Every
/// failure throws; the frames call is optional on the screen, which shows no screenshots when it fails.
extension GatewayBackend {
    public func runSteps(runID: String, afterSeq: Int?, limit: Int) async throws -> RunStepPage {
        let result = try await call(
            "runs.steps",
            .obj([
                "runId": .string(runID),
                "afterSeq": afterSeq.map { JSONValue.number(Double($0)) },
                "limit": .number(Double(limit)),
            ]))
        let steps = (result["steps"]?.array ?? []).compactMap(Self.runStepRow)
        let nextSeq = result["nextSeq"]?.double.map { Int($0) }
        return RunStepPage(steps: steps, nextSeq: nextSeq)
    }

    public func runFrames(runID: String) async throws -> [RunFrameRef] {
        let result = try await call("runs.frames", .obj(["runId": .string(runID)]))
        return (result["frames"]?.array ?? []).compactMap(Self.runFrameRef)
    }

    public func runFrameImage(runID: String, seq: Int, size: RunFrameSize) async throws -> Data {
        let result = try await call(
            "runs.frame", .obj(["runId": .string(runID), "seq": .number(Double(seq)), "size": .string(size.rawValue)]))
        guard let encoded = result["dataBase64"]?.string, let data = Data(base64Encoded: encoded) else {
            throw BackendError.notFound
        }
        return data
    }

    // MARK: -

    /// One step of `runs.steps`. A step without an id or a seq is dropped: the list could not order or dedupe it.
    static func runStepRow(_ s: JSONValue) -> RunStepRow? {
        guard let id = s["id"]?.string, let seq = s["seq"]?.double.map({ Int($0) }) else { return nil }
        let kind = RunStepKindName(rawValue: s["kind"]?.string ?? "")
        let status = TaskRunStep.Status(rawValue: s["status"]?.string ?? "") ?? .pending
        return RunStepRow(
            id: id, seq: seq, kind: kind, status: status,
            label: s["label"]?.string ?? "",
            doneLabel: s["doneLabel"]?.string,
            target: s["target"]?.string.flatMap { $0.isEmpty ? nil : $0 },
            startedAt: WireFormat.date(s["startedAt"]?.string),
            endedAt: WireFormat.date(s["endedAt"]?.string))
    }

    /// One frame of `runs.frames`. The Gateway's `stepId` is nullable: a frame with no step stays unplaced.
    static func runFrameRef(_ f: JSONValue) -> RunFrameRef? {
        guard let seq = f["seq"]?.double.map({ Int($0) }),
              let width = f["width"]?.double.map({ Int($0) }),
              let height = f["height"]?.double.map({ Int($0) })
        else { return nil }
        return RunFrameRef(
            seq: seq, stepID: f["stepId"]?.string, width: width, height: height,
            expired: f["expired"]?.bool ?? false)
    }
}
