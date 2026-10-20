import Foundation
import PsycheHelperCore
import PsycheProtocol
import Security

/// The running helper's bundle and signature, reported by `permissions.status` (packaging contract).
enum BundleIdentity {
    static func json(bundle: Bundle = .main) -> JSONValue {
        let info = bundle.infoDictionary ?? [:]
        let path = bundle.bundlePath
        var o: [String: JSONValue] = [
            "path": .string(path),
            "version": .string(info["CFBundleShortVersionString"] as? String ?? HelperVersion.current),
            "build": .string(info["CFBundleVersion"] as? String ?? ""),
            // Inside Psyche.app (Contents/Resources or Contents/Library/LoginItems).
            "insideApp": .bool(path.contains(".app/Contents/")),
        ]
        let s = signing()
        o["signing"] = .string(s.kind.rawValue)
        if let team = s.teamId { o["teamId"] = .string(team) }
        return .object(o)
    }

    static func signing() -> (kind: SigningKind, teamId: String?) {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return (.unsigned, nil) }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return (.unsigned, nil) }
        var cfInfo: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &cfInfo) == errSecSuccess,
              let info = cfInfo as? [String: Any]
        else { return (.unsigned, nil) }
        let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        let signed = info[kSecCodeInfoIdentifier as String] != nil
        let adhoc = flags & SecCodeSignatureFlags.adhoc.rawValue != 0
        var leaf: String?
        if let certs = info[kSecCodeInfoCertificates as String] as? [SecCertificate], let first = certs.first {
            leaf = SecCertificateCopySubjectSummary(first) as String?
        }
        let team = info[kSecCodeInfoTeamIdentifier as String] as? String
        return (SigningKind.classify(signed: signed, adhoc: adhoc, leafCommonName: leaf), team)
    }
}
