import AppKit
import Foundation
import PsycheHelperCore
import PsycheHelperSystem

// Psyche Helper (com.psyche.helper): the Mac node (architecture §6, §7). By default it stays
// connected to the Gateway's node socket and serves capabilities; it must run as its own
// responsible process (launched by launchd or LaunchServices, never as a shell child) so TCC
// grants belong to the helper (spike 04).

let usage = """
    usage: psyche-helper [--handshake-only [--challenge-only]] [--timeout <seconds>] [--manifest]

      (no flags)        stay connected to the Gateway and serve capabilities (reconnects)
      --handshake-only  connect, pair, print the phase and exit (smoke test)
      --challenge-only  with --handshake-only: stop after the challenge
      --manifest        print the capability manifest as JSON and exit

    Environment: PSYCHE_NODE_SOCKET (default $PSYCHE_HOME/run/node.sock), PSYCHE_HOME (default ~/.psyche).
    Exit codes (--handshake-only): 0 handshake done, 2 socket missing, 3 denied, 4 timeout, 1 other errors.
    """

var timeout: TimeInterval = 10
var handshakeOnly = false
var verify = true
var printManifest = false
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--timeout":
        guard let value = args.popFirst().flatMap(TimeInterval.init), value > 0 else {
            FileHandle.standardError.write(Data("\(usage)\n".utf8))
            exit(64)
        }
        timeout = value
    case "--handshake-only": handshakeOnly = true
    case "--challenge-only":
        handshakeOnly = true
        verify = false
    case "--manifest": printManifest = true
    case "-h", "--help":
        print(usage)
        exit(0)
    default:
        // LaunchServices may pass -psn_… on older systems; ignore it.
        if arg.hasPrefix("-psn_") { continue }
        FileHandle.standardError.write(Data("unknown argument: \(arg)\n\(usage)\n".utf8))
        exit(64)
    }
}

let log = HelperLog()

if printManifest {
    let runtime = HelperRuntime(log: HelperLog(echo: { _ in }))
    print(runtime.registry.manifest(version: HelperVersion.current).jsonString(pretty: true))
    exit(0)
}

let identity: DeviceIdentity
do {
    identity = try DeviceIdentityStores.resolve(log: log).identity
} catch {
    log.error("could not load the device identity: \(String(describing: type(of: error)))")
    exit(1)
}

if handshakeOnly {
    do {
        let socket = try UnixSocketConnection(path: HelperPaths.nodeSocketPath())
        defer { socket.close() }
        let client = NodeHandshakeClient(
            identity: identity,
            options: NodeHandshakeOptions(timeout: timeout, verify: verify, handshakeSecret: HelperPaths.readHandshakeSecret()),
            log: log
        )
        switch try client.run(on: socket) {
        case .challengeOnly: exit(0)
        case .result(let phase): exit(phase == "denied" ? 3 : 0)
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
}

// Long-running node: AppKit run loop on the main thread (notification delegate, content picker,
// Apple Events), the node connection on a background thread.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let runtime = HelperRuntime(log: log)
runtime.start()
let daemon = NodeDaemon(identity: identity, registry: runtime.registry, preflight: runtime.preflight, log: log)
let nodeThread = Thread { daemon.run() }
nodeThread.name = "com.psyche.helper.node"
nodeThread.start()
nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        log.info("stopping")
        daemon.stop()
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}
log.info("psyche-helper \(HelperVersion.current) started capabilities=\(runtime.registry.ordered.count)")
app.run()
