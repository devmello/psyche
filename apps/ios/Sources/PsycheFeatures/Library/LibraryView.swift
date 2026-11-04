import PsycheDesign
import SwiftUI

/// A placeholder until I6: documents, images, artifacts and downloads (docs/design/ios-app-2026.md §4.4).
struct LibraryView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader("Library")
                PaperCard(padding: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Your files are on your Mac")
                            .font(.psycheRow.weight(.semibold)).foregroundStyle(PsycheColor.text)
                        Text("Documents, images, artifacts and downloads will open here, as paper sheets.")
                            .font(.subheadline).foregroundStyle(PsycheColor.muted)
                    }
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
        }
        .psycheScreen()
        .psycheHidesNavigationBar()
    }
}
