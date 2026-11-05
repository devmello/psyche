import Foundation

// The running task in the `live` scenario comes alive once someone watches it (Home's Watch button): it
// advances a step every few seconds, then asks for an approval, then finishes once that is answered. This
// is how the Live Activity, the Dynamic Island and the approval notification demo with no Mac.

extension FixtureBackend {
    public static let demoApprovalID = "appr_q3_send"

    private static let demoDetails = [
        4: "reading the budget sheet", 5: "drafting the summary", 6: "ready to send to Dana", 7: "sending",
    ]

    /// Starts the script for `taskID` (once). Only a task in the fixture's running list has one.
    public func startRunningDemo(taskID: String, stepInterval: Duration = .seconds(4)) {
        guard demoTask == nil, homeState.snapshot.running.contains(where: { $0.id == taskID }) else { return }
        demoTask = Task { await self.runDemo(taskID: taskID, stepInterval: stepInterval) }
    }

    /// Debug checks of answering with the app closed: a freshly launched process starts the script already parked
    /// on its approval (step 6, the approval waiting), so the approval a Live Activity offers still exists when the
    /// system launches the app to answer it.
    public func startRunningDemoParkedOnApproval(taskID: String, stepInterval: Duration = .seconds(4)) {
        guard demoTask == nil, let index = homeState.snapshot.running.firstIndex(where: { $0.id == taskID }) else { return }
        homeState.snapshot.running[index].step = 6
        homeState.snapshot.running[index].detail = Self.demoDetails[6] ?? homeState.snapshot.running[index].detail
        if !homeState.snapshot.needsYou.contains(where: { $0.id == Self.demoApprovalID }) {
            homeState.snapshot.needsYou.insert(FixtureData.demoApproval, at: 0)
        }
        publish(.changed(.activity))
        publish(.changed(.home))
        demoTask = Task { await self.runDemo(taskID: taskID, stepInterval: stepInterval, parked: true) }
    }

    private func runDemo(taskID: String, stepInterval: Duration, parked: Bool = false) async {
        var askedForApproval = parked
        while !Task.isCancelled {
            try? await Task.sleep(for: askedForApproval ? .seconds(1) : stepInterval)
            guard let index = homeState.snapshot.running.firstIndex(where: { $0.id == taskID }) else { return }
            var task = homeState.snapshot.running[index]
            // Parked on the approval until it is answered (here or in a notification).
            if homeState.snapshot.needsYou.contains(where: { $0.id == Self.demoApprovalID }) { continue }
            if task.step < 6 {
                task.step += 1
                task.detail = Self.demoDetails[task.step] ?? task.detail
                homeState.snapshot.running[index] = task
            } else if !askedForApproval {
                askedForApproval = true
                homeState.snapshot.needsYou.insert(FixtureData.demoApproval, at: 0)
            } else if task.step == 6 {
                task.step = 7
                task.detail = Self.demoDetails[7] ?? task.detail
                homeState.snapshot.running[index] = task
            } else {
                homeState.snapshot.running.remove(at: index)
                agentState.recent.insert(RecentRun(id: taskID, title: task.title, outcome: .done, time: "now"), at: 0)
            }
            publish(.changed(.activity))
            publish(.changed(.home))
            if !homeState.snapshot.running.contains(where: { $0.id == taskID }) { return }
        }
    }
}

extension FixtureData {
    /// A `write` approval (no presence check) from the watched task, so it gets Approve and Deny.
    public static var demoApproval: NeedsYouItem {
        NeedsYouItem(
            id: FixtureBackend.demoApprovalID, kind: .approval, title: "Send the Q3 summary to Dana?",
            source: "Q3 review", time: Date.now.formatted(.dateTime.hour(.defaultDigits(amPM: .omitted)).minute()),
            approval: ApprovalDetail(
                kindLabel: "email", title: "Send the Q3 summary to Dana",
                summary: "The summary is ready. Psyche wants to email it to Dana.",
                fields: [
                    .init(key: "To", value: "Dana Reyes"), .init(key: "Subject", value: "Q3 review summary"),
                    .init(key: "Attachment", value: "Q3 summary.pdf"),
                ],
                evidence: ["thr_q3"], alsoSentTo: "Mac · expires 21:12", presenceNote: nil, allowLabel: "Allow"),
            threadID: "thr_q3", taskID: "task_q3")
    }
}
