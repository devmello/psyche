import PsycheClient
import PsycheDesign
import PsycheStore
import SwiftUI

/// The agent sheet (docs/design/ios-app-2026.md §4.8): what Psyche needs from you and what it is doing.
/// Approvals, Upcoming and Soul arrive with I5.
struct AgentSheet: View {
    @Environment(\.backend) private var store
    @State private var snapshot: HomeSnapshot?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                HStack(spacing: 12) {
                    MothAvatar(size: 44)
                    Text("Psyche").psycheTitle(.title)
                }
                if let snapshot {
                    if !snapshot.needsYou.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeader("Needs you", count: snapshot.needsYou.count, needsYou: true)
                            PaperCard {
                                ForEach(Array(snapshot.needsYou.enumerated()), id: \.element.id) { index, item in
                                    if index > 0 { HairlineDivider() }
                                    NeedsYouRow(
                                        title: item.title,
                                        evidence: [item.kind.rawValue.capitalized, item.source, item.time],
                                        showsChevron: false)
                                }
                            }
                        }
                    }
                    if !snapshot.running.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeader("Now")
                            PaperCard {
                                ForEach(snapshot.running) { task in
                                    NeedsYouRow(
                                        title: task.title,
                                        evidence: ["Step \(task.step) of \(task.stepCount)", task.elapsed],
                                        showsChevron: false)
                                }
                            }
                        }
                    }
                }
            }
            .padding(PsycheMetrics.pagePadding)
        }
        .psycheScreen()
        .presentationDragIndicator(.visible)
        .task { snapshot = try? await store.home() }
    }
}
