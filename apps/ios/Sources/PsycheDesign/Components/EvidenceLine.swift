import SwiftUI

/// The desktop's signature: one muted line of mono under what the agent did, parts joined by " · "
/// ("Because · calendar · rent-nov", "Approval · Bills automation · 9:12").
public struct EvidenceLine: View {
    private let text: String

    public init(_ parts: [String]) {
        text = parts.joined(separator: " · ")
    }

    public init(_ label: String, _ parts: [String]) {
        self.init([label] + parts)
    }

    public var body: some View {
        Text(text)
            .font(.psycheMono(.caption))
            .foregroundStyle(PsycheColor.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

#Preview("Evidence line") {
    VStack(alignment: .leading, spacing: 8) {
        EvidenceLine("Because", ["calendar", "rent-nov"])
        EvidenceLine(["Approval", "Bills automation", "9:12"])
    }
    .padding().psycheScreen()
}
