import Darwin
import Foundation
import PsycheHelperCore

/// Spawns a tool subprocess with TCC responsibility disclaimed, so it does not inherit the helper's
/// grants (security §12; the Claude desktop `disclaimer` pattern; spike 04). Uses the private
/// `responsibility_spawnattrs_setdisclaim` SPI when present; without it the spawn is refused rather
/// than silently inheriting the grants.
public enum DisclaimedProcess {
    public struct Output: Sendable {
        public var status: Int32
        public var stdout: String
        public var stderr: String
    }

    private typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

    private static let setDisclaim: SetDisclaim? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return nil }
        return unsafeBitCast(sym, to: SetDisclaim.self)
    }()

    public static var isSupported: Bool { setDisclaim != nil }

    /// Runs `path args` (absolute path only, no shell), capturing up to 1 MiB of each stream.
    public static func run(_ path: String, _ args: [String], timeout: TimeInterval) async throws -> Output {
        guard path.hasPrefix("/") else { throw CapabilityError.invalidParams("absolute path required") }
        guard let setDisclaim else {
            throw CapabilityError.unavailable("disclaim_unsupported", "This macOS cannot spawn tools without the helper's permissions")
        }
        return try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(with: Result { try spawn(path, args, timeout: timeout, setDisclaim: setDisclaim) })
            }
        }
    }

    private static func spawn(_ path: String, _ args: [String], timeout: TimeInterval, setDisclaim: SetDisclaim) throws -> Output {
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        guard setDisclaim(&attr, 1) == 0 else {
            throw CapabilityError.unavailable("disclaim_failed", "Could not disclaim responsibility for the subprocess")
        }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))

        let outPipe = Pipe()
        let errPipe = Pipe()
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, outPipe.fileHandleForWriting.fileDescriptor, 1)
        posix_spawn_file_actions_adddup2(&actions, errPipe.fileHandleForWriting.fileDescriptor, 2)

        // Minimal environment: no PSYCHE_* secrets, no handshake paths.
        let env = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=\(NSHomeDirectory())", "LANG=en_US.UTF-8"]
        let argv = ([path] + args).map { strdup($0) } + [nil]
        let envp = env.map { strdup($0) } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, path, &actions, &attr, argv, envp)
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()
        guard rc == 0 else { throw CapabilityError.unavailable("spawn_failed", "Could not start \(path) (\(rc))") }

        let group = DispatchGroup()
        nonisolated(unsafe) var out = Data()
        nonisolated(unsafe) var err = Data()
        group.enter()
        DispatchQueue.global().async {
            out = read(outPipe.fileHandleForReading)
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            err = read(errPipe.fileHandleForReading)
            group.leave()
        }
        let deadline = Date().addingTimeInterval(timeout)
        var status: Int32 = 0
        var timedOut = false
        while true {
            let r = waitpid(pid, &status, WNOHANG)
            if r == pid { break }
            if r < 0 && errno != EINTR { break }
            if Date() > deadline {
                kill(pid, SIGTERM)
                usleep(200_000)
                kill(pid, SIGKILL)
                _ = waitpid(pid, &status, 0)
                timedOut = true
                break
            }
            usleep(20_000)
        }
        group.wait()
        if timedOut { throw CapabilityError(.timeout, reason: "timeout", "\(path) timed out after \(Int(timeout)) s") }
        let exit = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        return Output(status: exit, stdout: String(decoding: out, as: UTF8.self), stderr: String(decoding: err, as: UTF8.self))
    }

    private static func read(_ h: FileHandle) -> Data {
        var data = Data()
        while true {
            let chunk = h.availableData
            if chunk.isEmpty { break }
            if data.count < 1 << 20 { data.append(chunk.prefix((1 << 20) - data.count)) }
        }
        return data
    }
}
