import PsycheDesign
import SwiftUI

/// The same "couldn't load" line the Library uses, with a retry. Also the retry row at the end of a paged list.
struct FailedNotice: View {
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Couldn't load this", bundle: .module).font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
            Button(String(localized: "Try again", bundle: .module), action: retry).buttonStyle(.psycheOutline).frame(maxWidth: 220)
        }
    }
}
