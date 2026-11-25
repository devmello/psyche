import Observation
import PsycheDesign
import PsycheStore
import SwiftUI

/// The words for a grant, shared with the desktop's Settings → Permissions (same kinds, scopes and subjects).
enum GrantWording {
    static func subject(_ subject: GrantSubject) -> String {
        switch subject {
        case .trustedSite(let host, let subdomains):
            subdomains ? String(localized: "\(host) and its subdomains", bundle: .module) : host
        case .origin(let host): host
        case .prepNotes: String(localized: "Notes titled “Prep:” (meeting prep)", bundle: .module)
        case .named(let name): name
        case .hostProgram(let program, _, let folder, let exact):
            exact
                ? String(localized: "\(program) in \(folder), exactly these arguments", bundle: .module)
                : String(localized: "\(program) in \(folder), any arguments", bundle: .module)
        case .command(let line, let folder):
            folder.map { String(localized: "\(line) in \($0)", bundle: .module) } ?? line
        case .email(let recipients, let account):
            account.map { String(localized: "to \(recipients) from \($0)", bundle: .module) }
                ?? String(localized: "to \(recipients)", bundle: .module)
        case .calendar(let id):
            id.map { String(localized: "Calendar \($0)", bundle: .module) } ?? String(localized: "Calendar", bundle: .module)
        case .other(let key): key
        }
    }

    /// A kind the phone has no words for shows as written.
    static func kind(_ kind: String) -> String {
        switch kind {
        case "new_origin": String(localized: "Website", bundle: .module)
        case "connector_action": String(localized: "Connector action", bundle: .module)
        case "send_email": String(localized: "Send email", bundle: .module)
        case "calendar_write": String(localized: "Calendar", bundle: .module)
        case "exec", "exec_host": String(localized: "Command", bundle: .module)
        case "file_write": String(localized: "File write", bundle: .module)
        case "mcp_tool": String(localized: "MCP tool", bundle: .module)
        case "credential_fill": String(localized: "Credential fill", bundle: .module)
        case "computer_action": String(localized: "Computer use", bundle: .module)
        default: kind
        }
    }

    static func scope(_ scope: String) -> String {
        switch scope {
        case "once": String(localized: "Once", bundle: .module)
        case "task": String(localized: "This task", bundle: .module)
        case "site": String(localized: "This site", bundle: .module)
        case "session": String(localized: "This session", bundle: .module)
        case "always": String(localized: "Always", bundle: .module)
        default: scope
        }
    }
}

@MainActor @Observable
final class StandingPermissionsModel {
    private(set) var phase: LoadPhase<[StandingGrant]> = .idle
    /// This phone holds admin: only then is Revoke offered. The Gateway still decides.
    private(set) var isAdmin = false
    /// The grant being revoked right now.
    private(set) var revoking: String?
    /// A failed revoke, inline: what the owner tried, and the Gateway's own words.
    private(set) var revokeError: String?
    private let store: any GrantsBackend

    init(store: any GrantsBackend) {
        self.store = store
    }

    func load() async {
        isAdmin = await store.canRevokeGrants()
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.standingGrants())
        } catch BackendError.refused {
            // A phone that may not read grants sees a plain note, not the Gateway's wording or a crash.
            phase = .failed(String(localized: "This phone can't see standing permissions.", bundle: .module))
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    /// Revokes one, then reads the list again so the row shows what the Gateway kept. A non-admin phone never
    /// calls: Revoke isn't offered, and this guards the same rule.
    func revoke(_ grant: StandingGrant) async {
        guard isAdmin, revoking == nil else { return }
        revoking = grant.id
        revokeError = nil
        defer { revoking = nil }
        do {
            try await store.revokeGrant(id: grant.id)
        } catch {
            revokeError = String(
                localized: "Couldn't revoke “\(GrantWording.subject(grant.subject))” (\(error.localizedDescription)). The permission is unchanged.",
                bundle: .module)
            return
        }
        // The Gateway kept the revoke: show it now, so a re-read that fails can't leave a stale Active row.
        if case .loaded(var grants) = phase, let index = grants.firstIndex(where: { $0.id == grant.id }) {
            grants[index].revokedAt = grants[index].revokedAt ?? .now
            phase = .loaded(grants)
        }
        await load()
    }
}

/// Settings → Standing permissions: what the owner said "Always allow" to, with use counts and expiry.
/// An admin phone can revoke one (a plain tap and a confirmation); any other phone sees the list only.
struct StandingPermissionsView: View {
    @State private var model: StandingPermissionsModel
    @State private var confirming: StandingGrant?

    init(store: any GrantsBackend) {
        _model = State(initialValue: StandingPermissionsModel(store: store))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PsycheMetrics.sectionSpacing) {
                if let error = model.revokeError {
                    Text(error).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("grants.revokeError")
                }
                switch model.phase {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                case .loaded(let grants):
                    if grants.isEmpty {
                        Text("No standing permissions yet. Choosing “Always allow” on an approval adds one here.", bundle: .module)
                            .font(.subheadline).foregroundStyle(PsycheColor.muted)
                    } else {
                        PaperStack {
                            ForEach(Array(grants.enumerated()), id: \.element.id) { index, grant in
                                if index > 0 { HairlineDivider() }
                                row(grant)
                            }
                        }
                    }
                    if !model.isAdmin {
                        EditOnMacNote(text: String(localized: "Revoking needs admin access. Use your Mac or an admin phone.", bundle: .module))
                    }
                case .failed(let message):
                    VStack(spacing: 12) {
                        Text("Couldn't load this", bundle: .module).font(.headline)
                        Text(message).font(.subheadline).foregroundStyle(PsycheColor.muted)
                        Button(String(localized: "Try again", bundle: .module)) { Task { await model.load() } }
                            .buttonStyle(.psycheOutline).frame(maxWidth: 220)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .psycheScreen()
        .navigationTitle(String(localized: "Standing permissions", bundle: .module))
        .psycheInlineTitle()
        .refreshable { await model.load() }
        .task { await model.load() }
        .confirmationDialog(
            confirming.map { String(localized: "Revoke “\(GrantWording.subject($0.subject))”?", bundle: .module) } ?? "",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible, presenting: confirming
        ) { grant in
            Button(String(localized: "Revoke", bundle: .module), role: .destructive) { Task { await model.revoke(grant) } }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: { grant in
            if let detail = grant.subject.detail {
                Text(verbatim: detail) + Text(verbatim: "\n")
                    + Text("Psyche will ask again the next time it needs this.", bundle: .module)
            } else {
                Text("Psyche will ask again the next time it needs this.", bundle: .module)
            }
        }
    }

    private func row(_ grant: StandingGrant) -> some View {
        let status = grant.status()
        let name = GrantWording.subject(grant.subject)
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.psycheRow).foregroundStyle(status == .active ? PsycheColor.text : PsycheColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(GrantWording.kind(grant.kind)) · \(GrantWording.scope(grant.scope))")
                    .font(.footnote).foregroundStyle(PsycheColor.muted)
                if let detail = grant.subject.detail {
                    Text(detail).font(.system(.footnote, design: .monospaced)).foregroundStyle(PsycheColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(usage(grant)).font(.footnote).foregroundStyle(PsycheColor.muted)
                if status == .active, model.isAdmin {
                    Button(String(localized: "Revoke", bundle: .module)) { confirming = grant }
                        .buttonStyle(.bordered).controlSize(.small).fixedSize()
                        .padding(.top, 4)
                        .disabled(model.revoking != nil)
                        .accessibilityLabel(String(localized: "Revoke permission: \(name)", bundle: .module))
                        .accessibilityIdentifier("grants.revoke.\(grant.id)")
                }
            }
            Spacer(minLength: 8)
            statusLabel(status)
        }
        .padding(PsycheMetrics.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func statusLabel(_ status: GrantStatus) -> some View {
        switch status {
        case .revoked: Text("Revoked", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
        case .expired: Text("Expired", bundle: .module).font(.subheadline).foregroundStyle(PsycheColor.muted)
        case .active: EmptyView()
        }
    }

    /// "Used 3 times · Last used 2 days ago", with the expiry for a grant that has one.
    private func usage(_ grant: StandingGrant) -> String {
        var parts: [String] = []
        if grant.useCount == 0 {
            parts.append(String(localized: "Never used", bundle: .module))
        } else {
            parts.append(String(localized: "Used \(grant.useCount) times", bundle: .module))
            if let last = grant.lastUsedAt {
                let ago = last.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
                parts.append(String(localized: "Last used \(ago)", bundle: .module))
            }
        }
        if let expires = grant.expiresAt, grant.status() == .active {
            let when = expires.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
            parts.append(String(localized: "Expires \(when)", bundle: .module))
        }
        return parts.joined(separator: " · ")
    }
}
