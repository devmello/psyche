import SwiftUI

/// The approval's facts: a card with the amber hairline (not a left stripe), a key and its value. Nested details
/// are indented under their heading, and code or a command is set in mono. Nothing is truncated (security §3.7):
/// long values wrap, and the card scrolls with the sheet.
public struct ApprovalCard: View {
    public struct Field: Identifiable, Sendable {
        public var key: String
        public var value: String
        /// How far down the nested details this row sits; each level indents the row.
        public var depth: Int
        /// Code or a command: the value is set in mono and stacked under its key.
        public var monospaced: Bool
        public var id: String
        public init(key: String, value: String, depth: Int = 0, monospaced: Bool = false, id: String? = nil) {
            self.key = key
            self.value = value
            self.depth = depth
            self.monospaced = monospaced
            self.id = id ?? key
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
                    row(field)
                        .padding(.leading, CGFloat(min(field.depth, 8)) * 14)
                        .padding(.vertical, 11)
                        .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ field: Field) -> some View {
        if field.value.isEmpty {
            // A heading over the nested rows below it.
            Text(field.key).font(.subheadline.weight(.semibold)).foregroundStyle(PsycheColor.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if field.monospaced || field.value.count > 40 {
            VStack(alignment: .leading, spacing: 4) {
                Text(field.key).font(.subheadline).foregroundStyle(PsycheColor.muted)
                value(field)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Text(field.key).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    .fixedSize()
                Spacer(minLength: 0)
                value(field)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private func value(_ field: Field) -> some View {
        Group {
            if field.monospaced {
                Text(field.value).font(.psycheMono(.subheadline, weight: .medium))
            } else {
                Text(field.value).font(.subheadline.weight(.medium))
            }
        }
        .foregroundStyle(PsycheColor.text)
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .textSelection(.enabled)
    }
}

#Preview("Approval") {
    ApprovalCard(fields: [
        .init(key: "Amount", value: "$84.20 USD"), .init(key: "Payee", value: "PG&E"),
        .init(key: "Site", value: "pge.com/pay"),
    ])
    .padding().psycheScreen()
}
