#if !os(iOS)
import SwiftUI

// `swift test` builds this package for macOS, where the Library's UIKit screens don't exist. These stand
// in so the rest of the module compiles; the app is iOS only.
struct LibraryView: View {
    var body: some View { EmptyView() }
}

struct LibraryItemView: View {
    let id: String
    var body: some View { EmptyView() }
}
#endif
