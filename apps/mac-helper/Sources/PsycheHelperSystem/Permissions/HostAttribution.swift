import Foundation
import PsycheHelperCore
import PsycheProtocol
import Security

/// The app tccd attributes the helper's requests to, read from disk (#570).
struct HostAttribution: Sendable {
    let path: String
    let bundleId: String
    let name: String
    let info: [String: any Sendable]
    let entitlements: [String: any Sendable]
    let hardened: Bool

    /// nil when the helper is not nested in another app.
    static func current(bundlePath: String = Bundle.main.bundlePath) -> HostAttribution? {
        guard let host = TCCAttribution.enclosingApp(of: bundlePath), let b = Bundle(path: host), let info = b.infoDictionary else { return nil }
        var ents: [String: any Sendable] = [:]
        var hardened = false
        var code: SecStaticCode?
        if SecStaticCodeCreateWithPath(URL(fileURLWithPath: host) as CFURL, [], &code) == errSecSuccess, let code {
            var cf: CFDictionary?
            if SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &cf) == errSecSuccess, let d = cf as? [String: Any] {
                for (k, v) in (d[kSecCodeInfoEntitlementsDict as String] as? [String: Any]) ?? [:] { if let v = v as? Bool { ents[k] = v } }
                let flags = (d[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
                hardened = flags & SecCodeSignatureFlags.runtime.rawValue != 0
            }
        }
        var plain: [String: any Sendable] = [:]
        for (k, v) in info { if let s = v as? String { plain[k] = s } }
        return HostAttribution(path: host, bundleId: b.bundleIdentifier ?? "unknown", name: (info["CFBundleName"] as? String) ?? (host as NSString).lastPathComponent,
                               info: plain, entitlements: ents, hardened: hardened)
    }

    func missing(_ p: TCCPermission) -> TCCAttribution.Missing {
        TCCAttribution.missing(p, hostInfo: info, hostEntitlements: entitlements, hardened: hardened)
    }

    /// Throws `prompt_refused_by_macos` when tccd would refuse `p` without a prompt.
    static func check(_ p: TCCPermission) throws {
        guard let host = current() else { return }
        let m = host.missing(p)
        if !m.isEmpty { throw TCCAttribution.refusal(p, hostName: host.name, hostId: host.bundleId, missing: m) }
    }

    /// For `permissions.status`: the attributed app and, per permission, what it lacks.
    func json() -> JSONValue {
        var gaps: [String: JSONValue] = [:]
        for p in TCCPermission.allCases {
            let m = missing(p)
            guard !m.isEmpty else { continue }
            gaps[p.rawValue] = ["usageKeys": .array(m.usageKeys.map { .string($0) }), "entitlement": m.entitlement.map { .string($0) } ?? .null]
        }
        return ["app": .string(bundleId), "path": .string(path), "hardenedRuntime": .bool(hardened), "missing": .object(gaps)]
    }
}
