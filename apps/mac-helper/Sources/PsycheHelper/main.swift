import Foundation
import PsycheHelperCore

// psyche-helper: bootstrap node (S00). Connects to the Gateway's node socket, sends `connect` as
// role "node" with no capabilities, logs the challenge, and (unless --challenge-only) completes
// `connect.verify` and logs the resulting phase. S14 turns this into the Psyche Helper.app.

let usage = """
    usage: psyche-helper [--timeout <seconds>] [--challenge-only]

    Environment: PSYCHE_NODE_SOCKET (default $PSYCHE_HOME/run/node.sock), PSYCHE_HOME (default ~/.psyche).
    Exit codes: 0 handshake done, 2 socket missing, 3 denied, 4 timeout, 1 other errors.
    """

var timeout: TimeInterval = 10
var verify = true
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--timeout":
        guard let value = args.popFirst().flatMap(TimeInterval.init), value > 0 else {
            FileHandle.standardError.write(Data("\(usage)\n".utf8))
            exit(64)
        }
        timeout = value
    case "--challenge-only":
        verify = false
    case "-h", "--help":
        print(usage)
        exit(0)
    default:
        FileHandle.standardError.write(Data("unknown argument: \(arg)\n\(usage)\n".utf8))
        exit(64)
    }
}

let log = HelperLog()
let socketPath = HelperPaths.nodeSocketPath()
do {
    let socket = try UnixSocketConnection(path: socketPath)
    defer { socket.close() }
    let client = NodeHandshakeClient(
        identity: DeviceIdentity(),
        options: NodeHandshakeOptions(timeout: timeout, verify: verify, handshakeSecret: HelperPaths.readHandshakeSecret()),
        log: log
    )
    switch try client.run(on: socket) {
    case .challengeOnly:
        exit(0)
    case .result(let phase):
        exit(phase == "denied" ? 3 : 0)
    }
} catch let error as NodeSocketError {
    log.error(error.description)
    switch error {
    case .socketMissing: exit(2)
    case .timedOut: exit(4)
    default: exit(1)
    }
} catch {
    log.error(String(describing: error))
    exit(1)
}
