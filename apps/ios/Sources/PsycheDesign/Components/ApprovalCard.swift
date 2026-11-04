import SwiftUI

/// The approval's facts: a card with the amber hairline (not a left stripe), a key on the left and the
/// value in mono on the right. Nothing is truncated (security §3.7): long values wrap.
public struct ApprovalCard: View {
    public struct Field: Identifiable, Sendable {
        public var key: String
        public var value: String
        public var id: String { key }
        public init(key: String, value: String) {
            self.key = key
            self.value = value
        }
    }

    private let fields: [Field]

    public init(fields: [Field]) {
        self.fields = fields
    }

    public var body: some View {
        PaperCard(
            padding: EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16),
            radius: PsycheMetrics.approvalRadius, border: PsycheColor.amber
        ) {
            VStack(spacing: 0) {
                ForEach(Array(fields.enumerated()), id: \.element.id) { index, field in
                    if index > 0 { HairlineDivider() }
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(field.key).font(.subheadline).foregroundStyle(PsycheColor.muted)
                            .fixedSize()
                        Spacer(minLength: 0)
                        Text(field.value)
                            .font(.psycheMono(.subheadline, weight: .medium))
                            .foregroundStyle(PsycheColor.text)
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                            .layoutPriority(1)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 11)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

#Preview("Approval") {
    ApprovalCard(fields: [
        .init(key: "Amount", value: "$84.20 USD"), .init(key: "Payee", value: "PG&E"),
        .init(key: "Site", value: "pge.com/pay"),
    ])
    .padding().psycheScreen()
}
