import Foundation

/// Line-oriented Unix-socket control channel between `vzspike start` (owns the VM) and the
/// short-lived client subcommands. Handlers run on the main queue, where the VM lives.
final class ControlServer {
    let path: String
    let fd: Int32

    init(path: String, handler: @escaping (String, @escaping (String) -> Void) -> Void) {
        self.path = path
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        guard path.utf8.count < MemoryLayout.size(ofValue: addr.sun_path) else { fail("socket path too long: \(path)") }
        withUnsafeMutableBytes(of: &addr.sun_path) { p in
            path.utf8CString.withUnsafeBytes { p.copyMemory(from: $0) }
        }
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard r == 0, listen(fd, 8) == 0 else { fail("control socket bind: \(String(cString: strerror(errno)))") }
        chmod(path, 0o600)
        let lfd = fd
        Thread.detachNewThread {
            while true {
                let c = accept(lfd, nil, nil)
                if c < 0 { continue }
                guard let line = readLine(fd: c, timeout: 5) else { close(c); continue }
                DispatchQueue.main.async {
                    handler(line) { out in
                        let d = (out + "\n").data(using: .utf8)!
                        _ = d.withUnsafeBytes { write(c, $0.baseAddress, d.count) }
                        close(c)
                    }
                }
            }
        }
    }

    deinit { close(fd); unlink(path) }
}

func controlRequest(_ path: String, _ line: String, timeout: Int = 300) -> String {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    defer { close(fd) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { p in
        path.utf8CString.withUnsafeBytes { p.copyMemory(from: $0) }
    }
    let r = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard r == 0 else { return "ERR not running (\(path))" }
    let d = (line + "\n").data(using: .utf8)!
    _ = d.withUnsafeBytes { write(fd, $0.baseAddress, d.count) }
    return readLine(fd: fd, timeout: timeout) ?? "ERR no reply"
}
