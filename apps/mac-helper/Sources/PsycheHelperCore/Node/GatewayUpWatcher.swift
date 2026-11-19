import Foundation

/// Calls `onChange` when something in `$PSYCHE_HOME/run` changes. The Gateway rewrites
/// `run/node-socket` on every start, so a directory write is the "Gateway is up" signal that lets the
/// daemon skip the rest of its backoff. A vnode source: no polling, no wakeups while nothing changes.
/// It only reads the directory's change events; it never reads or follows what the Gateway wrote.
public final class GatewayUpWatcher: @unchecked Sendable {
    private let source: DispatchSourceFileSystemObject

    /// nil when the directory does not exist yet (the daemon then relies on its backoff).
    public init?(environment: [String: String] = ProcessInfo.processInfo.environment, onChange: @escaping @Sendable () -> Void) {
        let dir = (HelperPaths.nodeSocketPointerPath(environment: environment) as NSString).deletingLastPathComponent
        let fd = open(dir, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: DispatchQueue(label: "com.psyche.helper.gateway-up", qos: .utility))
        s.setEventHandler(handler: onChange)
        s.setCancelHandler { close(fd) }
        s.resume()
        source = s
    }

    deinit { source.cancel() }
}
