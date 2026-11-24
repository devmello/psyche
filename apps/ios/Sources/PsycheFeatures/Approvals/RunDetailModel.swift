import Foundation
import Observation
import PsycheStore

extension RunStepList {
    /// What the run details screen draws while the first page is in flight.
    static var skeleton: RunStepList {
        var list = RunStepList()
        list.append(RunStepPage(
            steps: (1...3).map { RunStepRow(id: "skrun\($0)", seq: $0, kind: nil, status: .pending, label: "Placeholder step") },
            nextSeq: nil))
        return list
    }
}

/// A run's steps and screenshots. The first page loads with the screen; "Load more" asks for the next page
/// from the last `nextSeq`. The frames are optional: when they fail, the steps still show and no screenshot
/// does, with no error.
@MainActor @Observable
final class RunDetailModel {
    private(set) var phase: LoadPhase<RunStepList> = .idle
    private(set) var frames: [RunFrameRef] = []
    /// A next page is in flight: its button waits.
    private(set) var loadingMore = false
    /// A failed "Load more", shown inline. The steps already on the screen stay.
    private(set) var error: String?
    let runID: String
    private let store: any PsycheBackend

    init(store: any PsycheBackend, runID: String) {
        self.store = store
        self.runID = runID
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            var list = RunStepList()
            list.append(try await store.runSteps(runID: runID, afterSeq: nil, limit: RunStepPaging.pageSize))
            phase = .loaded(list)
            error = nil
        } catch {
            if phase.value == nil {
                phase = .failed(error.localizedDescription)
            } else {
                self.error = error.localizedDescription
            }
            return
        }
        frames = (try? await store.runFrames(runID: runID)) ?? []
    }

    func loadMore() async {
        guard !loadingMore, var list = phase.value, let after = list.nextSeq else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            list.append(try await store.runSteps(runID: runID, afterSeq: after, limit: RunStepPaging.pageSize))
            phase = .loaded(list)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The screenshots placed on one step. Expired frames have no picture and are not listed.
    func frames(for stepID: String) -> [RunFrameRef] {
        frames.filter { $0.stepID == stepID && !$0.expired }
    }

    func imageData(for frame: RunFrameRef) async throws -> Data {
        try await store.runFrameImage(runID: runID, seq: frame.seq)
    }
}
