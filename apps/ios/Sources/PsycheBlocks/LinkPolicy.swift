import SwiftUI

/// What a link in model-written text may do. Chat Markdown comes from an agent that read untrusted pages, so a
/// link is never opened on a tap alone: only `http` and `https` leave the app, and only after the person has
/// seen the host they lead to; `psyche://` routes stay inside the app. Everything else (`javascript:`, `file:`,
/// `tel:`, `sms:`, `data:`, any other app's scheme) is not a link at all.
public enum LinkPolicy {
    public enum Decision: Equatable, Sendable {
        /// An in-app route (`psyche://chat/thr_1`): handed to the app's own URL handler.
        case internalRoute
        /// A web link: confirmed first, showing `host`.
        case confirmExternal(host: String)
        case blocked
    }

    public static func decision(for url: URL) -> Decision {
        switch url.scheme?.lowercased() {
        case "psyche":
            return url.host?.isEmpty == false ? .internalRoute : .blocked
        case "http", "https":
            guard let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return .blocked }
            return .confirmExternal(host: host.lowercased())
        default:
            return .blocked
        }
    }

    /// Link attributes in `text` that the policy blocks are removed, so they draw as plain text and cannot be tapped.
    static func sanitized(_ text: AttributedString) -> AttributedString {
        var result = text
        for run in result.runs {
            guard let link = run.link else { continue }
            if decision(for: link) == .blocked { result[run.range].link = nil }
        }
        return result
    }
}

private struct ConfirmExternalLinks: ViewModifier {
    @State private var pending: URL?
    @Environment(\.openURL) private var systemOpen

    private var host: String {
        guard let pending, case .confirmExternal(let host) = LinkPolicy.decision(for: pending) else { return "" }
        return host
    }

    func body(content: Content) -> some View {
        content
            .environment(
                \.openURL,
                OpenURLAction { url in
                    switch LinkPolicy.decision(for: url) {
                    case .internalRoute: return .systemAction  // the app's `onOpenURL` takes it from here
                    case .confirmExternal:
                        pending = url
                        return .handled
                    case .blocked: return .discarded
                    }
                }
            )
            .confirmationDialog(
                "Open \(host)?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                titleVisibility: .visible
            ) {
                Button("Open in browser") {
                    if let url = pending { systemOpen(url) }
                    pending = nil
                }
                Button("Cancel", role: .cancel) { pending = nil }
            } message: {
                Text(pending?.absoluteString ?? "")
            }
    }
}

extension View {
    /// Routes link taps through `LinkPolicy`: a web link asks "Open <host>?" first, an in-app route goes to the app.
    public func confirmsExternalLinks() -> some View { modifier(ConfirmExternalLinks()) }
}
