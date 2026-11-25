import SwiftUI

extension View {
    /// The system's collapsing large title on a root screen (a no-op on the package's macOS test build).
    @ViewBuilder
    func psycheLargeTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.large)
        #else
        self
        #endif
    }
}
