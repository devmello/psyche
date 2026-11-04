import SwiftUI

#if os(iOS)
import UIKit
#endif

/// Process-wide UIKit appearance: the large navigation title is New York like the in-content page titles.
public enum PsycheAppearance {
    @MainActor
    public static func install() {
        #if os(iOS)
        let base = UIFont.systemFont(ofSize: 34, weight: .semibold)
        let serif = base.fontDescriptor.withDesign(.serif).map { UIFont(descriptor: $0, size: 34) } ?? base
        let scaled = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: serif)
        UINavigationBar.appearance().largeTitleTextAttributes = [.font: scaled]
        #endif
    }
}

extension View {
    /// Root screens draw their own serif header, so the system bar stays out of the way.
    @ViewBuilder
    public func psycheHidesNavigationBar() -> some View {
        #if os(iOS)
        toolbarVisibility(.hidden, for: .navigationBar)
        #else
        self
        #endif
    }

    /// Inline title (pushed pages).
    @ViewBuilder
    public func psycheInlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}
