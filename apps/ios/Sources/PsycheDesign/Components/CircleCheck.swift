import SwiftUI

/// The to-do checkbox: an empty ring, or a muted filled circle with a check when handed in.
public struct CircleCheck: View {
    private let done: Bool

    public init(done: Bool) {
        self.done = done
    }

    public var body: some View {
        ZStack {
            if done {
                Circle().fill(PsycheColor.muted)
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(PsycheColor.sheet)
            } else {
                Circle().strokeBorder(PsycheColor.muted.opacity(0.7), lineWidth: 1.5)
            }
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}
