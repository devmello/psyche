import Foundation

/// Filesystem locations from the wire spec: `$PSYCHE_HOME` defaults to `~/.psyche`; the node socket
/// is `$PSYCHE_HOME/run/node.sock` unless `PSYCHE_NODE_SOCKET` overrides it.
public enum HelperPaths {
    public static func psycheHome(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let home = env["PSYCHE_HOME"], !home.isEmpty { return home }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".psyche")
    }

    public static func nodeSocketPath(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let path = env["PSYCHE_NODE_SOCKET"], !path.isEmpty { return path }
        return (psycheHome(environment: env) as NSString).appendingPathComponent("run/node.sock")
    }

    public static func handshakeSecretPath(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (psycheHome(environment: env) as NSString).appendingPathComponent("run/handshake.secret")
    }

    /// The per-launch handshake secret, if the Gateway wrote one (trimmed). Never logged.
    public static func readHandshakeSecret(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        guard let data = FileManager.default.contents(atPath: handshakeSecretPath(environment: env)),
              let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else { return nil }
        return text
    }
}
