import Foundation
import PsycheStore
import Testing

/// The run details screen's pure model: pages append in seq order with no step shown twice, and the list
/// stops asking once the Gateway's nextSeq is null.
struct RunStepListTests {
    private func row(_ seq: Int, status: TaskRunStep.Status = .ok) -> RunStepRow {
        RunStepRow(id: "stp_\(seq)", seq: seq, kind: .tool, status: status, label: "Step \(seq)", doneLabel: "Did \(seq)")
    }

    @Test func pagesAppendInSeqOrderWithoutDuplicates() {
        var list = RunStepList()
        list.append(RunStepPage(steps: [row(1), row(2)], nextSeq: 2))
        #expect(list.hasMore)
        list.append(RunStepPage(steps: [row(2), row(3)], nextSeq: 3))
        list.append(RunStepPage(steps: [row(4)], nextSeq: nil))
        #expect(list.steps.map(\.seq) == [1, 2, 3, 4])
        #expect(list.nextSeq == nil)
        #expect(!list.hasMore)
    }

    @Test func aLateStepFromAnOlderPageIsPlacedInOrder() {
        var list = RunStepList()
        list.append(RunStepPage(steps: [row(3)], nextSeq: 3))
        list.append(RunStepPage(steps: [row(1), row(2)], nextSeq: nil))
        #expect(list.steps.map(\.seq) == [1, 2, 3])
    }

    @Test func aFinishedStepShowsItsPastTenseOtherwiseItsStatusLine() {
        #expect(row(1, status: .ok).title == "Did 1")
        #expect(row(2, status: .running).title == "Step 2")
        #expect(row(3, status: .failed).title == "Step 3")
    }
}
