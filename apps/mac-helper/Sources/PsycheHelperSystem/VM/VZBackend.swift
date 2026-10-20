import AppKit
import Foundation
import PsycheHelperCore
import PsycheProtocol
@preconcurrency import Virtualization
#if canImport(DiskImageKit)
import DiskImageKit
#endif

/// SDK feature gates. DiskImageKit and `VZMacGuestProvisioningOptions` ship in the macOS 27 SDK;
/// CI builds with the 26 SDK, where the helper falls back to RAW sparse disks and reports
/// `supportsGuestProvisioning: false`.
public enum VZBackendInfo {
    public static var asifAvailable: Bool {
        #if canImport(DiskImageKit)
        if #available(macOS 27.0, *) { return true }
        #endif
        return false
    }

    public static var provisioningAvailable: Bool {
        #if canImport(DiskImageKit)
        if #available(macOS 27.0, *) { return true }
        #endif
        return false
    }
}

/// Virtualization.framework backend (spike 06 recipe). Every VM object lives on its own serial
/// queue. Needs the `com.apple.security.virtualization` entitlement; without it even the restore
/// image catalog fails (VZErrorDomain 10001), reported as `unavailable/virtualization_entitlement`.
public final class VZBackend: VMBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var guests: [String: RunningGuest] = [:]

    public init() {}

    public var supportsGuestProvisioning: Bool { VZBackendInfo.provisioningAvailable }

    public var activeCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return guests.count
    }

    public func isRunning(_ name: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return guests[name] != nil
    }

    static func mapError(_ error: Error) -> CapabilityError {
        let ns = error as NSError
        if ns.domain == VZErrorDomain {
            switch ns.code {
            case 10001: return CapabilityError(.unavailable, reason: "virtualization_entitlement", "The restore image catalog failed to load (is the helper signed with com.apple.security.virtualization?)")
            case 6: return CapabilityError(.unavailable, reason: "guest_limit", "The maximum supported number of active virtual machines has been reached.", retryable: true)
            default: break
            }
        }
        return CapabilityError(.unavailable, reason: "vz_error", "Virtualization failed (\(ns.domain) \(ns.code))", details: ["code": .int(ns.code)])
    }

    // MARK: Restore images

    static func info(_ image: VZMacOSRestoreImage) -> RestoreImageInfo {
        let v = image.operatingSystemVersion
        return RestoreImageInfo(url: image.url, version: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", build: image.buildVersion)
    }

    public func latestRestoreImage() async throws -> RestoreImageInfo {
        let image = try await withCheckedThrowingContinuation { (c: CheckedContinuation<ImageBox, Error>) in
            VZMacOSRestoreImage.fetchLatestSupported { c.resume(with: $0.map(ImageBox.init).mapError { Self.mapError($0) }) }
        }.image
        var info = Self.info(image)
        info.sizeBytes = try? await Self.remoteSize(image.url)
        return info
    }

    public func loadRestoreImage(_ url: URL) async throws -> RestoreImageInfo {
        Self.info(try await Self.load(url))
    }

    struct ImageBox: @unchecked Sendable { let image: VZMacOSRestoreImage }

    static func load(_ url: URL) async throws -> VZMacOSRestoreImage {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<ImageBox, Error>) in
            VZMacOSRestoreImage.load(from: url) { c.resume(with: $0.map(ImageBox.init).mapError { mapError($0) }) }
        }.image
    }

    static func remoteSize(_ url: URL) async throws -> Int64? {
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        let (_, res) = try await URLSession.shared.data(for: req)
        return res.expectedContentLength > 0 ? res.expectedContentLength : nil
    }

    public func download(_ image: RestoreImageInfo, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        let (bytes, response) = try await URLSession.shared.bytes(from: image.url)
        let total = max(1, response.expectedContentLength)
        let partial = file.appendingPathExtension("partial")
        FileManager.default.createFile(atPath: partial.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let handle = try FileHandle(forWritingTo: partial)
        defer { try? handle.close() }
        var buffer = Data()
        buffer.reserveCapacity(4 << 20)
        var written: Int64 = 0
        var lastReport = 0.0
        for try await byte in bytes {
            buffer.append(byte)
            if buffer.count >= 4 << 20 {
                try handle.write(contentsOf: buffer)
                written += Int64(buffer.count)
                buffer.removeAll(keepingCapacity: true)
                let f = Double(written) / Double(total)
                if f - lastReport >= 0.01 {
                    lastReport = f
                    progress(f)
                }
                try _Concurrency.Task.checkCancellation()
            }
        }
        try handle.write(contentsOf: buffer)
        try handle.close()
        try FileManager.default.moveItem(at: partial, to: file)
        progress(1)
    }

    // MARK: Bundle and install (L1)

    public func prepareBundle(_ bundle: VMBundle, config: VMConfig, image: URL) async throws {
        let restore = try await Self.load(image)
        guard let requirements = restore.mostFeaturefulSupportedConfiguration, requirements.hardwareModel.isSupported else {
            throw CapabilityError(.unavailable, reason: "image_unsupported", "This Mac cannot run macOS \(Self.info(restore).version) as a guest")
        }
        guard config.cpus >= requirements.minimumSupportedCPUCount, UInt64(config.memoryGB) << 30 >= requirements.minimumSupportedMemorySize else {
            throw CapabilityError.invalidParams("macOS \(Self.info(restore).version) needs at least \(requirements.minimumSupportedCPUCount) CPUs and \(requirements.minimumSupportedMemorySize >> 30) GB")
        }
        let hw = requirements.hardwareModel
        try hw.dataRepresentation.write(to: bundle.hardwareModelURL, options: .atomic)
        try VZMacMachineIdentifier().dataRepresentation.write(to: bundle.machineIdentifierURL, options: .atomic)
        do {
            _ = try VZMacAuxiliaryStorage(creatingStorageAt: bundle.auxiliaryStorageURL, hardwareModel: hw, options: [])
        } catch {
            throw Self.mapError(error)
        }
        try Self.createDisk(bundle.diskURL(format: config.diskFormat), format: config.diskFormat, gigabytes: config.diskGB)
        for url in [bundle.hardwareModelURL, bundle.machineIdentifierURL, bundle.auxiliaryStorageURL, bundle.diskURL(format: config.diskFormat)] {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }

    static func createDisk(_ url: URL, format: String, gigabytes: Int) throws {
        let bytes = UInt64(gigabytes) * 1_000_000_000
        #if canImport(DiskImageKit)
        if format == "asif", #available(macOS 27.0, *) {
            _ = try DiskImage(creating: .asif(url: url, blockCount: Int(bytes / 512), blockSize: .bytes512))
            return
        }
        #endif
        // RAW: a sparse file (APFS allocates on write).
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CapabilityError(.unavailable, reason: "disk_create", "Could not create the guest disk")
        }
        let fd = open(url.path, O_RDWR)
        defer { close(fd) }
        guard fd >= 0, ftruncate(fd, off_t(bytes)) == 0 else {
            throw CapabilityError(.unavailable, reason: "disk_create", "Could not size the guest disk")
        }
    }

    public func install(_ bundle: VMBundle, config: VMConfig, image: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        let guest = try RunningGuest(name: config.name, bundle: bundle, config: config, shares: [])
        try await guest.onQueue { () throws -> Void in }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            guest.queue.async {
                let installer = VZMacOSInstaller(virtualMachine: guest.vm, restoringFromImageAt: image)
                let timer = DispatchSource.makeTimerSource(queue: guest.queue)
                timer.schedule(deadline: .now() + 2, repeating: 2)
                timer.setEventHandler { progress(installer.progress.fractionCompleted) }
                timer.resume()
                installer.install { result in
                    timer.cancel()
                    c.resume(with: result.mapError { Self.mapError($0) })
                }
            }
        }
        progress(1)
    }

    // MARK: Run (L2, L3, L5)

    public func start(
        _ bundle: VMBundle, config: VMConfig, shares: [ShareGrant], system: VMSystemShares, provisioning: GuestProvisioning?,
        restoreFrom: URL?, onGatewayConnection: @escaping @Sendable (Int32) -> Void, onStop: @escaping @Sendable (String?) -> Void
    ) async throws {
        let guest = try RunningGuest(name: config.name, bundle: bundle, config: config, shares: shares, system: system)
        guest.onGatewayConnection = onGatewayConnection
        guest.onStop = { [weak self] error in
            self?.lock.withLock { _ = self?.guests.removeValue(forKey: config.name) }
            onStop(error)
        }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            guest.queue.async {
                guest.attachListener()
                if let restoreFrom {
                    // Warm start (spike 06: unproven on 27.0.1, code 11); the caller falls back to a cold boot.
                    guest.vm.restoreMachineStateFrom(url: restoreFrom) { error in
                        if let error { c.resume(throwing: CapabilityError(.unavailable, reason: "restore_failed", "Restoring the saved state failed (\((error as NSError).code))")); return }
                        guest.vm.resume { r in c.resume(with: r.mapError { Self.mapError($0) }) }
                    }
                    return
                }
                let options = VZMacOSVirtualMachineStartOptions()
                do {
                    if let provisioning { try Self.apply(provisioning, to: options) }
                } catch {
                    c.resume(throwing: error)
                    return
                }
                guest.vm.start(options: options) { error in
                    if let error { c.resume(throwing: Self.mapError(error)) } else { c.resume() }
                }
            }
        }
        lock.withLock { guests[config.name] = guest }
    }

    static func apply(_ p: GuestProvisioning, to options: VZMacOSVirtualMachineStartOptions) throws {
        #if canImport(DiskImageKit)
        if #available(macOS 27.0, *) {
            let o = VZMacGuestProvisioningOptions()
            o.username = p.username
            o.password = p.password
            o.fullName = p.fullName
            o.logsInAutomatically = p.autoLogin
            o.enablesRemoteLogin = p.remoteLogin
            do {
                try o.validate()
                try options.setGuestProvisioning(o)
            } catch {
                throw CapabilityError(.invalidParams, reason: "provisioning_invalid", "Guest provisioning options were rejected")
            }
            return
        }
        #endif
        throw CapabilityError(.unavailable, reason: "provisioning_unsupported", "Unattended setup needs macOS 27")
    }

    func guest(_ name: String) throws -> RunningGuest {
        guard let g = lock.withLock({ guests[name] }) else {
            throw CapabilityError(.conflict, reason: "vm_not_running", "\(name) is not running")
        }
        return g
    }

    public func stop(_ name: String, force: Bool) async throws -> Bool {
        guard let guest = lock.withLock({ guests[name] }) else { return true }
        _ = try? await guest.onQueue { [guest] in try guest.vm.requestStop() }
        if await guest.waitForStop(timeout: force ? 15 : 60) { return true }
        guard force else {
            throw CapabilityError(.unavailable, reason: "guest_did_not_stop",
                                  "The guest did not shut down (requestStop is ignored by a logged-in macOS guest). Retry with force: true.", retryable: true)
        }
        try await guest.forceStop()
        return false
    }

    public func pause(_ name: String) async throws {
        let g = try guest(name)
        try await g.call { vm, done in vm.pause { done($0) } }
        g.markPaused(true)
    }

    public func resume(_ name: String) async throws {
        let g = try guest(name)
        try await g.call { vm, done in vm.resume { done($0) } }
        g.markPaused(false)
    }

    public func saveState(_ name: String, to url: URL) async throws {
        let g = try guest(name)
        if !g.isPaused { try await g.call { vm, done in vm.pause { done($0) } } }
        do {
            try await g.call { vm, done in vm.saveMachineStateTo(url: url) { done($0.map { .failure($0) } ?? .success(())) } }
        } catch {
            try? await g.call { vm, done in vm.resume { done($0) } }
            throw CapabilityError(.unavailable, reason: "save_failed", "Saving the machine state failed (spike 06 saw code 11 on 27.0.1); the guest keeps running")
        }
        try await g.forceStop()
    }

    public func setShares(_ name: String, shares: [ShareGrant], system: VMSystemShares) async throws {
        guard let guest = lock.withLock({ guests[name] }) else { return }
        try await guest.onQueue { guest.replaceShares(shares, system: system) }
    }

    public func setDisplay(_ name: String, visible: Bool) async throws {
        let g = try guest(name)
        await MainActor.run { g.setDisplay(visible) }
    }

    public func connectGuestAgent(_ name: String) async throws -> Int32 {
        let g = try guest(name)
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<Int32, Error>) in
            g.queue.async {
                guard let sock = g.vm.socketDevices.first as? VZVirtioSocketDevice else {
                    c.resume(throwing: CapabilityError.unavailable("no_socket_device", "The guest has no vsock device"))
                    return
                }
                sock.connect(toPort: VsockPorts.guestControl) { result in
                    switch result {
                    case .success(let conn):
                        let fd = dup(conn.fileDescriptor)
                        conn.close()
                        if fd >= 0 { c.resume(returning: fd) } else { c.resume(throwing: CapabilityError.unavailable("vsock_dup", "vsock descriptor unavailable")) }
                    case .failure:
                        c.resume(throwing: CapabilityError(.unavailable, reason: "guest_agent_unreachable", "The guest helper is not listening yet (install Psyche in the guest)", retryable: true))
                    }
                }
            }
        }
    }

    public func isPaused(_ name: String) -> Bool { lock.withLock { guests[name] }?.isPaused ?? false }

    public func isDisplayVisible(_ name: String) -> Bool { lock.withLock { guests[name] }?.displayVisible ?? false }
}

/// One VZVirtualMachine with its queue, vsock listener and the live `psyche` share device.
final class RunningGuest: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate, @unchecked Sendable {
    let name: String
    let queue: DispatchQueue
    let vm: VZVirtualMachine
    let listener = VZVirtioSocketListener()
    var connections: [VZVirtioSocketConnection] = []
    var onGatewayConnection: (@Sendable (Int32) -> Void)?
    var onStop: (@Sendable (String?) -> Void)?
    private var stopWaiters: [CheckedContinuation<Void, Never>] = []

    private(set) var isPaused = false
    func markPaused(_ p: Bool) { isPaused = p }
    private(set) var displayVisible = false
    private var window: NSWindow?

    init(name: String, bundle: VMBundle, config: VMConfig, shares: [ShareGrant], system: VMSystemShares? = nil) throws {
        self.name = name
        queue = DispatchQueue(label: "com.psyche.helper.vm.\(name)")
        let c = try Self.configuration(bundle: bundle, config: config, shares: shares, system: system ?? .of(bundle))
        vm = VZVirtualMachine(configuration: c, queue: queue)
        super.init()
        queue.sync { vm.delegate = self }
    }

    func onQueue<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, Error>) in queue.async { c.resume(with: Result { try body() }) } }
    }

    /// Runs a completion-style VM call on `queue`.
    func call(_ body: @escaping @Sendable (VZVirtualMachine, @escaping @Sendable (Result<Void, Error>) -> Void) -> Void) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            queue.async { [self] in body(vm) { c.resume(with: $0.mapError { VZBackend.mapError($0) }) } }
        }
    }

    /// On the main thread: a window with the guest display (VZVirtualMachineView).
    @MainActor
    func setDisplay(_ visible: Bool) {
        if visible {
            if window == nil {
                let view = VZVirtualMachineView()
                view.virtualMachine = vm
                view.capturesSystemKeys = true
                view.automaticallyReconfiguresDisplay = true
                let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable, .miniaturizable],
                                 backing: .buffered, defer: false)
                w.title = "Sandbox Mac — \(name)"
                w.contentView = view
                w.isReleasedWhenClosed = false
                w.center()
                window = w
            }
            window?.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate()
        } else {
            window?.orderOut(nil)
        }
        displayVisible = visible
    }

    static func systemDirectories(_ system: VMSystemShares) -> (automount: [String: VZSharedDirectory], psyche: [String: VZSharedDirectory]) {
        var auto: [String: VZSharedDirectory] = ["psyche-in": VZSharedDirectory(url: system.transferIn, readOnly: true)]
        if let p = system.payload { auto["psyche-payload"] = VZSharedDirectory(url: p, readOnly: true) }
        return (auto, ["_psyche-out": VZSharedDirectory(url: system.transferOut, readOnly: false)])
    }

    static func configuration(bundle: VMBundle, config: VMConfig, shares: [ShareGrant], system: VMSystemShares) throws -> VZVirtualMachineConfiguration {
        let c = VZVirtualMachineConfiguration()
        let platform = VZMacPlatformConfiguration()
        guard let hw = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: bundle.hardwareModelURL)), hw.isSupported,
              let mid = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: bundle.machineIdentifierURL))
        else { throw CapabilityError(.unavailable, reason: "bundle_invalid", "The guest's hardware model or identifier is unusable on this Mac") }
        platform.hardwareModel = hw
        platform.machineIdentifier = mid
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: bundle.auxiliaryStorageURL)
        c.platform = platform
        c.bootLoader = VZMacOSBootLoader()
        c.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount, min(config.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
        c.memorySize = UInt64(config.memoryGB) << 30
        let gfx = VZMacGraphicsDeviceConfiguration()
        gfx.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: config.displayWidth, heightInPixels: config.displayHeight, pixelsPerInch: 80)]
        c.graphicsDevices = [gfx]
        c.keyboards = [VZMacKeyboardConfiguration()]
        c.pointingDevices = [VZMacTrackpadConfiguration(), VZUSBScreenCoordinatePointingDeviceConfiguration()]
        let disk = try VZDiskImageStorageDeviceAttachment(
            url: bundle.diskURL(format: config.diskFormat), readOnly: false, cachingMode: .automatic, synchronizationMode: .full
        )
        c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
        let net = VZVirtioNetworkDeviceConfiguration()
        net.attachment = VZNATNetworkDeviceAttachment()  // NAT only (no bridged entitlement for third parties)
        if let mac = VZMACAddress(string: config.macAddress) { net.macAddress = mac }
        c.networkDevices = [net]
        c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        c.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        // Both devices always exist: only their share sets can change live (spike 06).
        try? FileManager.default.createDirectory(at: system.transferIn, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? FileManager.default.createDirectory(at: system.transferOut, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let (autoDirs, psycheDirs) = systemDirectories(system)
        let user = VZVirtioFileSystemDeviceConfiguration(tag: ShareGrant.userTag)
        user.share = directoryShare(shares.filter { $0.tag == ShareGrant.userTag }, extra: psycheDirs)
        let auto = VZVirtioFileSystemDeviceConfiguration(tag: VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag)
        auto.share = VZMultipleDirectoryShare(directories: autoDirs)
        c.directorySharingDevices = [user, auto]
        do {
            try c.validate()
        } catch {
            throw VZBackend.mapError(error)
        }
        return c
    }

    static func directoryShare(_ shares: [ShareGrant], extra: [String: VZSharedDirectory] = [:]) -> VZDirectoryShare {
        var dirs: [String: VZSharedDirectory] = extra
        for s in shares { dirs[s.name] = VZSharedDirectory(url: URL(fileURLWithPath: s.hostPath), readOnly: s.readOnly) }
        return VZMultipleDirectoryShare(directories: dirs)
    }

    /// On `queue`.
    func replaceShares(_ shares: [ShareGrant], system: VMSystemShares) {
        let (autoDirs, psycheDirs) = Self.systemDirectories(system)
        for case let dev as VZVirtioFileSystemDevice in vm.directorySharingDevices {
            if dev.tag == ShareGrant.userTag {
                dev.share = Self.directoryShare(shares.filter { $0.tag == ShareGrant.userTag }, extra: psycheDirs)
            } else if dev.tag == VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag {
                dev.share = VZMultipleDirectoryShare(directories: autoDirs)
            }
        }
    }

    /// On `queue`.
    func attachListener() {
        guard let sock = vm.socketDevices.first as? VZVirtioSocketDevice else { return }
        listener.delegate = self
        sock.setSocketListener(listener, forPort: VsockPorts.gatewayNode)
    }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        let fd = dup(connection.fileDescriptor)
        guard fd >= 0, let handler = onGatewayConnection else { return false }
        connections.append(connection)
        handler(fd)
        return true
    }

    func waitForStop(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let state = (try? await onQueue { [self] in vm.state }) ?? .stopped
            if state == .stopped || state == .error { return true }
            try? await _Concurrency.Task.sleep(nanoseconds: 500_000_000)
        }
        return false
    }

    func forceStop() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            queue.async { [self] in vm.stop { error in if let error { c.resume(throwing: VZBackend.mapError(error)) } else { c.resume() } } }
        }
        onStop?(nil)
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        connections.forEach { $0.close() }
        connections.removeAll()
        onStop?(nil)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        connections.forEach { $0.close() }
        connections.removeAll()
        onStop?(VZBackend.mapError(error).reason)
    }
}
