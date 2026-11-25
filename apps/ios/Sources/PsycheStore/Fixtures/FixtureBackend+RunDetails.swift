import CoreGraphics
import Foundation
import ImageIO

// The run details screen's fixture: one run with five steps, the third of which has a screenshot. The
// scenario `-psycheScenario live` shows it from the task run page.

extension FixtureData {
    /// The run `FixtureBackend.taskRun` reports for every fixture task.
    public static let runID = "run_fixture_1"

    /// Five steps in seq order. Step 3 is a browser step, so the one frame sits on it.
    public static let runTrace: [RunStepRow] = {
        let start = Date.now.addingTimeInterval(-340)
        return [
            RunStepRow(id: "rstp1", seq: 1, kind: .tool, status: .ok, label: "Opening the expense folder",
                       doneLabel: "Opened the expense folder", target: "Drive / Expenses",
                       startedAt: start, endedAt: start.addingTimeInterval(20)),
            RunStepRow(id: "rstp2", seq: 2, kind: .model, status: .ok, label: "Reading the receipts",
                       doneLabel: "Read the receipts", startedAt: start.addingTimeInterval(20),
                       endedAt: start.addingTimeInterval(110)),
            RunStepRow(id: "rstp3", seq: 3, kind: .tool, status: .ok, label: "Opening the expense site",
                       doneLabel: "Opened the expense site", target: "expenses.example.com",
                       startedAt: start.addingTimeInterval(110), endedAt: start.addingTimeInterval(150)),
            RunStepRow(id: "rstp4", seq: 4, kind: .memory, status: .ok, label: "Remembering Dana's address",
                       doneLabel: "Remembered Dana's address", startedAt: start.addingTimeInterval(150),
                       endedAt: start.addingTimeInterval(160)),
            RunStepRow(id: "rstp5", seq: 5, kind: .approval, status: .waiting, label: "Sending the report to Dana",
                       target: "dana@example.com", startedAt: start.addingTimeInterval(160)),
        ]
    }()

    /// The one frame: the expense site, as Psyche saw it on step 3.
    public static let runFrames: [RunFrameRef] = [
        RunFrameRef(seq: 1, stepID: "rstp3", width: 320, height: 200),
    ]
}

extension FixtureBackend {
    public func runSteps(runID: String, afterSeq: Int?, limit: Int) async throws -> RunStepPage {
        await pause()
        guard runID == FixtureData.runID else { throw BackendError.notFound }
        let after = afterSeq ?? 0
        let steps = Array(FixtureData.runTrace.filter { $0.seq > after }.prefix(limit))
        // Like the Gateway: a full page says there may be more, and the next page then comes back empty.
        return RunStepPage(steps: steps, nextSeq: steps.count == limit ? steps.last?.seq : nil)
    }

    public func runFrames(runID: String) async throws -> [RunFrameRef] {
        await pause()
        guard runID == FixtureData.runID else { throw BackendError.notFound }
        return FixtureData.runFrames
    }

    public func runFrameImage(runID: String, seq: Int, size: RunFrameSize) async throws -> Data {
        await pause()
        guard runID == FixtureData.runID, FixtureData.runFrames.contains(where: { $0.seq == seq }) else {
            throw BackendError.notFound
        }
        return try Self.framePNG()
    }

    /// A stand-in browser frame drawn with CoreGraphics: a header bar and a grid of cards.
    static func framePNG() throws -> Data {
        let width = 320, height = 200
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw BackendError.notFound }
        context.setFillColor(CGColor(red: 0.37, green: 0.40, blue: 0.47, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.17, green: 0.35, blue: 0.63, alpha: 1))
        context.fill(CGRect(x: 20, y: 144, width: 280, height: 20))
        for row in 0..<3 {
            for column in 0..<6 {
                let light = (row + column) % 2 == 0
                context.setFillColor(light
                    ? CGColor(red: 0.96, green: 0.96, blue: 0.94, alpha: 1)
                    : CGColor(red: 0.91, green: 0.90, blue: 0.87, alpha: 1))
                context.fill(CGRect(x: 20 + column * 46, y: 24 + row * 38, width: 40, height: 32))
            }
        }
        guard let image = context.makeImage() else { throw BackendError.notFound }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else {
            throw BackendError.notFound
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw BackendError.notFound }
        return data as Data
    }
}
