import PsycheDesign
import SwiftUI

/// A generative-UI widget (`ui` block). I8 replaces this body with the native renderer; until then the
/// phone says where to find it. Keep this file self-contained: it takes only the widget id.
struct WidgetSlot: View {
    let widgetID: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "rectangle.on.rectangle").font(.caption).foregroundStyle(PsycheColor.muted)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("Open on your Mac").font(.psycheRow.weight(.medium)).foregroundStyle(PsycheColor.text)
                Text(widgetID).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PsycheColor.sheet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(PsycheColor.rule, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityHint("This widget can't be shown on the phone yet")
    }
}
