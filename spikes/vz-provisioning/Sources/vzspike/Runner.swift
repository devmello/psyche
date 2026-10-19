import AppKit
import Foundation
import Virtualization

struct StartOptions {
    var window = false
    var restoreState = false
    var provisioning: VZMacGuestProvisioningOptions? = nil
    var recovery = false
    /// Exit after the guest answers on SSH (used by `provision` to time first boot).
    var waitForSSH = false
    /// Script run on the host once SSH answers: <script> <ip>; its exit status is reported.
    var afterSSH: String? = nil
    var stopAfterScript = false
}

/// Runs one VM in this process. The process stays alive while the VM runs and listens on
/// <bundle>/control.sock so `stop`, `share`, `vsock-echo` and `save` can talk to it.
final class Runner: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
    let bundle: VMBundle
    var cfg: VMConfig
    let opts: StartOptions
    var vm: VZVirtualMachine!
    var vmConfig: VZVirtualMachineConfiguration!
    var builder: MachineBuilder
    var control: ControlServer?
    var window: NSWindow?
    var hostConnections: [VZVirtioSocketConnection] = []
    let listener = VZVirtioSocketListener()
    var t0 = 0.0

    static let hostEchoPort: UInt32 = 5000

    init(bundle: VMBundle, cfg: VMConfig, opts: StartOptions) {
        self.bundle = bundle
        self.cfg = cfg
        self.opts = opts
        self.builder = MachineBuilder(bundle: bundle, cfg: cfg)
    }

    func run() -> Never {
        if !controlRequest(bundle.controlSocket, "status", timeout: 2).hasPrefix("ERR") {
            fail("a VM already runs from this bundle (\(bundle.controlSocket))")
        }
        do {
            let c = try builder.build()
            if opts.restoreState { try c.validateSaveRestoreSupport() }
            vmConfig = c
            vm = VZVirtualMachine(configuration: c)
            vm.delegate = self
        } catch {
            fail("configuration: \(error)")
        }

        if let sock = vm.socketDevices.first as? VZVirtioSocketDevice {
            listener.delegate = self
            sock.setSocketListener(listener, forPort: Runner.hostEchoPort)
        }

        control = ControlServer(path: bundle.controlSocket) { [weak self] line, reply in
            self?.handle(line, reply: reply) ?? reply("ERR gone")
        }

        t0 = now()
        if opts.restoreState {
            startFromSavedState()
        } else {
            let so = VZMacOSVirtualMachineStartOptions()
            so.startUpFromMacOSRecovery = opts.recovery
            if let p = opts.provisioning {
                do { try so.setGuestProvisioning(p) } catch { fail("setGuestProvisioningOptions: \(error)") }
            }
            vm.start(options: so) { [self] err in
                if let err { fail("start: \(err)") }
                bundle.recordTiming(opts.provisioning != nil ? "start-provisioning" : "start-cold", seconds: now() - t0)
                afterStart()
            }
        }

        if opts.window {
            let app = NSApplication.shared
            app.setActivationPolicy(.regular)
            let view = VZVirtualMachineView()
            view.virtualMachine = vm
            view.capturesSystemKeys = true
            view.automaticallyReconfiguresDisplay = true
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "vzspike — \(bundle.root.lastPathComponent)"
            w.contentView = view
            w.center()
            w.makeKeyAndOrderFront(nil)
            window = w
            app.activate(ignoringOtherApps: true)
            app.run()
        }
        RunLoop.main.run()
        exit(0)
    }

    func startFromSavedState() {
        vm.restoreMachineStateFrom(url: bundle.stateURL) { [self] err in
            if let err { fail("restoreMachineState: \(err)") }
            vm.resume { [self] r in
                if case .failure(let e) = r { fail("resume: \(e)") }
                bundle.recordTiming("restore-state+resume", seconds: now() - t0)
                // The framework invalidates the save file after restore: the disk no longer matches it.
                try? FileManager.default.removeItem(at: bundle.stateURL)
                afterStart()
            }
        }
    }

    func afterStart() {
        log("vm running (pid \(getpid())); control socket \(bundle.controlSocket)")
        pollAgent()
        DispatchQueue.global().async { [self] in
            let deadline = now() + 1800
            while now() < deadline {
                // Re-read the lease file every time: the NAT subnet can move between boots
                // (other vmnet users, host network changes), leaving stale leases for this MAC.
                if let ip = guestIP(mac: cfg.macAddress), tcpOpen(ip, 22) {
                    bundle.recordTiming("ssh-reachable", seconds: now() - t0, extra: ["ip": ip])
                    print("GUEST_IP=\(ip)")
                    fflush(stdout)
                    afterSSH(ip: ip)
                    return
                }
                usleep(500_000)
            }
            log("guest never answered on :22 within 30 min")
            if opts.waitForSSH { exit(2) }
        }
    }

    /// Times "start → the in-guest agent answers a ping over vsock" (no IP involved).
    func pollAgent(deadline: Double = now() + 900) {
        guard now() < deadline else { return log("agent never answered on vsock 7000") }
        vsockRequest(port: 7000, message: #"{"op":"ping"}"#, timeout: 2) { [self] r in
            if r.contains("pong") {
                bundle.recordTiming("agent-vsock-ready", seconds: now() - t0)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollAgent(deadline: deadline) }
            }
        }
    }

    func afterSSH(ip: String) {
        if let script = opts.afterSSH {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = [script, ip]
            let t = now()
            do { try p.run() } catch { log("after-ssh script: \(error)") }
            p.waitUntilExit()
            bundle.recordTiming("after-ssh-script", seconds: now() - t, extra: ["status": "\(p.terminationStatus)"])
        }
        if opts.stopAfterScript {
            DispatchQueue.main.async { self.gracefulStop { _ in exit(0) } }
        } else if opts.waitForSSH && opts.afterSSH == nil {
            exit(0)
        }
    }

    // MARK: control protocol: one line in, one line out.

    func handle(_ line: String, reply: @escaping (String) -> Void) {
        let parts = line.split(separator: " ", maxSplits: 4).map(String.init)
        switch parts.first ?? "" {
        case "status":
            reply("OK state=\(vm.state.rawValue) ip=\(guestIP(mac: cfg.macAddress) ?? "-")")
        case "stop":
            gracefulStop { how in reply("OK stopped (\(how))"); DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) } }
        case "kill":
            vm.stop { _ in reply("OK killed"); DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) } }
        case "save":
            save(to: parts.count > 1 ? URL(fileURLWithPath: parts[1]) : bundle.stateURL, reply: reply)
        case "share":
            // share <tag> <name> <path> ro|rw   — replaces/adds one directory on a running device
            guard parts.count == 5 else { return reply("ERR usage: share <tag> <name> <path> ro|rw") }
            share(ShareSpec(tag: parts[1], name: parts[2], path: parts[3], readOnly: parts[4] != "rw"), reply: reply)
        case "unshare":
            guard parts.count == 3 else { return reply("ERR usage: unshare <tag> <name>") }
            cfg.shares.removeAll { $0.tag == parts[1] && $0.name == parts[2] }
            applyShares(tag: parts[1], reply: reply)
        case "vsock":
            // vsock <port> <message>
            guard parts.count >= 3, let port = UInt32(parts[1]) else { return reply("ERR usage: vsock <port> <msg>") }
            vsockRequest(port: port, message: parts[2...].joined(separator: " "), reply: reply)
        default:
            reply("ERR unknown command")
        }
    }

    func gracefulStop(_ done: @escaping (String) -> Void) {
        let t = now()
        // requestStop() (virtual power button) is ignored by a logged-in macOS 27 guest, so ask
        // the in-guest agent to shut down first; requestStop stays as a no-agent fallback.
        vsockRequest(port: 7000, message: #"{"op":"shutdown"}"#, timeout: 5) { r in log("agent shutdown: \(r)") }
        do { try vm.requestStop() } catch { log("requestStop: \(error)") }
        // Give the guest 90 s to shut down cleanly, then pull the plug.
        func poll(_ n: Int) {
            if vm.state == .stopped { bundle.recordTiming("graceful-stop", seconds: now() - t); return done("graceful") }
            if n == 0 { vm.stop { _ in done("forced") }; return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { poll(n - 1) }
        }
        poll(180)
    }

    func save(to url: URL, reply: @escaping (String) -> Void) {
        let t = now()
        do { try vmConfig.validateSaveRestoreSupport() } catch { return reply("ERR not saveable: \(error)") }
        vm.pause { [self] r in
            if case .failure(let e) = r { return reply("ERR pause: \(e)") }
            try? FileManager.default.removeItem(at: url)    // the framework creates it
            vm.saveMachineStateTo(url: url) { [self] err in
                if let err {
                    vm.resume { _ in }
                    return reply("ERR save: \(err)")
                }
                let size = Disk.allocatedBytes(url)
                bundle.recordTiming("pause+save-state", seconds: now() - t, extra: ["bytes": "\(size)"])
                vm.stop { _ in
                    reply("OK saved \(size) bytes")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
                }
            }
        }
    }

    func share(_ s: ShareSpec, reply: @escaping (String) -> Void) {
        cfg.shares.removeAll { $0.tag == s.tag && $0.name == s.name }
        cfg.shares.append(s)
        applyShares(tag: s.tag, reply: reply)
    }

    /// VZVirtioFileSystemDevice.share can be replaced while the VM runs; the device (tag) itself
    /// must have existed in the configuration at start.
    func applyShares(tag: String, reply: (String) -> Void) {
        guard let dev = vm.directorySharingDevices.compactMap({ $0 as? VZVirtioFileSystemDevice }).first(where: { $0.tag == tag }) else {
            return reply("ERR no VirtioFS device with tag \(tag) (devices are fixed at start)")
        }
        dev.share = MachineBuilder.directoryShare(cfg.shares.filter { $0.tag == tag })
        try? bundle.saveConfig(cfg)
        reply("OK tag=\(tag) shares=\(cfg.shares.filter { $0.tag == tag }.map { "\($0.name):\($0.readOnly ? "ro" : "rw")" })")
    }

    func vsockRequest(port: UInt32, message: String, timeout: Int = 10, reply: @escaping (String) -> Void) {
        guard let dev = vm.socketDevices.first as? VZVirtioSocketDevice else { return reply("ERR no socket device") }
        let t = now()
        dev.connect(toPort: port) { [self] r in
            switch r {
            case .failure(let e):
                reply("ERR connect: \(e.localizedDescription)")
            case .success(let conn):
                let connectSecs = now() - t
                hostConnections.append(conn)
                DispatchQueue.global().async { [self] in
                    let fd = conn.fileDescriptor
                    let out = (message + "\n").data(using: .utf8)!
                    _ = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }
                    let line = readLine(fd: fd, timeout: timeout)
                    let rtt = now() - t
                    DispatchQueue.main.async { [self] in
                        conn.close()
                        hostConnections.removeAll { $0 === conn }
                        reply(String(format: "OK connect=%.1fms rtt=%.1fms reply=%@", connectSecs * 1000, rtt * 1000, line ?? "<timeout>"))
                    }
                }
            }
        }
    }

    // MARK: guest → host (port 5000): line echo, standing in for a host capability such as the vault.

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        hostConnections.append(connection)
        DispatchQueue.global().async { [self] in
            let fd = connection.fileDescriptor
            while let line = readLine(fd: fd, timeout: 30) {
                let out = "host-echo: \(line)\n".data(using: .utf8)!
                _ = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }
            }
            DispatchQueue.main.async { [self] in
                connection.close()
                hostConnections.removeAll { $0 === connection }
            }
        }
        return true
    }

    // MARK: VZVirtualMachineDelegate

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        bundle.recordTiming("guest-did-stop", seconds: now() - t0)
        exit(0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fail("vm stopped with error: \(error)")
    }
}

/// Reads one \n-terminated line from a blocking fd, nil on EOF/timeout.
func readLine(fd: Int32, timeout: Int) -> String? {
    var tv = timeval(tv_sec: timeout, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var buf = [UInt8]()
    var byte: UInt8 = 0
    while true {
        let n = read(fd, &byte, 1)
        if n <= 0 { return buf.isEmpty ? nil : String(decoding: buf, as: UTF8.self) }
        if byte == 10 { return String(decoding: buf, as: UTF8.self) }
        buf.append(byte)
    }
}
