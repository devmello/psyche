import Foundation
import Virtualization

/// Builds the VZVirtualMachineConfiguration for a bundle. Same shape for install and run,
/// so the hardware model / machine identifier / aux storage stay consistent.
struct MachineBuilder {
    let bundle: VMBundle
    let cfg: VMConfig
    var disk: DiskHandle?

    init(bundle: VMBundle, cfg: VMConfig) {
        self.bundle = bundle
        self.cfg = cfg
    }

    mutating func build(withShares: Bool = true) throws -> VZVirtualMachineConfiguration {
        let c = VZVirtualMachineConfiguration()
        c.label = "psyche-spike06 \(bundle.root.lastPathComponent)"

        let platform = VZMacPlatformConfiguration()
        guard let hw = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: bundle.hardwareModelURL)) else {
            throw msg("bad HardwareModel")
        }
        guard hw.isSupported else { throw msg("hardware model not supported on this host") }
        guard let mid = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: bundle.machineIdentifierURL)) else {
            throw msg("bad MachineIdentifier")
        }
        platform.hardwareModel = hw
        platform.machineIdentifier = mid
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: bundle.auxStorageURL)
        c.platform = platform
        c.bootLoader = VZMacOSBootLoader()

        c.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                         min(cfg.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
        c.memorySize = UInt64(cfg.memoryGB) * 1024 * 1024 * 1024

        let gfx = VZMacGraphicsDeviceConfiguration()
        gfx.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1200, pixelsPerInch: 80)]
        c.graphicsDevices = [gfx]
        c.keyboards = [VZMacKeyboardConfiguration()]
        c.pointingDevices = [VZMacTrackpadConfiguration(), VZUSBScreenCoordinatePointingDeviceConfiguration()]

        let d = try Disk.attachment(bundle: bundle, cfg: cfg)
        disk = d
        c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: d.attachment)]

        let net = VZVirtioNetworkDeviceConfiguration()
        net.attachment = VZNATNetworkDeviceAttachment()
        guard let mac = VZMACAddress(string: cfg.macAddress) else { throw msg("bad MAC \(cfg.macAddress)") }
        net.macAddress = mac
        c.networkDevices = [net]

        c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        c.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        c.socketDevices = [VZVirtioSocketDeviceConfiguration()]

        if withShares {
            c.directorySharingDevices = MachineBuilder.shareDevices(cfg.shares)
        }
        // Spike-only bisection switch: VZSPIKE_DROP=balloon,socket,entropy,trackpad,usbpointer,net,shares
        let drop = Set((ProcessInfo.processInfo.environment["VZSPIKE_DROP"] ?? "").split(separator: ",").map(String.init))
        if drop.contains("balloon") { c.memoryBalloonDevices = [] }
        if drop.contains("socket") { c.socketDevices = [] }
        if drop.contains("entropy") { c.entropyDevices = [] }
        if drop.contains("trackpad") { c.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()] }
        if drop.contains("usbpointer") { c.pointingDevices = [VZMacTrackpadConfiguration()] }
        if drop.contains("net") { c.networkDevices = [] }
        if drop.contains("shares") { c.directorySharingDevices = [] }
        try c.validate()
        return c
    }

    /// One VirtioFS device per tag; shares with the same tag become one VZMultipleDirectoryShare.
    static func shareDevices(_ shares: [ShareSpec]) -> [VZDirectorySharingDeviceConfiguration] {
        var tags: [String] = []
        for s in shares where !tags.contains(s.tag) { tags.append(s.tag) }
        return tags.map { tag in
            let dev = VZVirtioFileSystemDeviceConfiguration(tag: tag)
            dev.share = directoryShare(shares.filter { $0.tag == tag })
            return dev
        }
    }

    static func directoryShare(_ shares: [ShareSpec]) -> VZDirectoryShare {
        var dirs: [String: VZSharedDirectory] = [:]
        for s in shares {
            dirs[s.name] = VZSharedDirectory(url: URL(fileURLWithPath: s.path), readOnly: s.readOnly)
        }
        return VZMultipleDirectoryShare(directories: dirs)
    }
}

func msg(_ s: String) -> NSError { NSError(domain: "vzspike", code: 1, userInfo: [NSLocalizedDescriptionKey: s]) }

/// Finds the guest's NAT address from the host's DHCP lease file (vmnet's bootpd writes it;
/// readable without root). hw_address octets are written without leading zeros.
func guestIP(mac: String) -> String? {
    guard let text = try? String(contentsOfFile: "/var/db/dhcpd_leases", encoding: .utf8) else { return nil }
    let want = mac.lowercased().split(separator: ":").map { String(Int($0, radix: 16)!, radix: 16) }.joined(separator: ":")
    var best: (ip: String, lease: UInt64)?
    for block in text.components(separatedBy: "}") {
        var ip: String?, hw: String?, lease: UInt64 = 0
        for line in block.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("ip_address=") { ip = String(t.dropFirst(11)) }
            if t.hasPrefix("hw_address=") { hw = t.dropFirst(11).split(separator: ",").last.map(String.init) }
            if t.hasPrefix("lease=0x") { lease = UInt64(t.dropFirst(8), radix: 16) ?? 0 }
        }
        if let ip, hw?.lowercased() == want, lease >= (best?.lease ?? 0) { best = (ip, lease) }
    }
    return best?.ip
}

func tcpOpen(_ host: String, _ port: UInt16, timeout: Int32 = 1) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    inet_pton(AF_INET, host, &addr.sin_addr)
    var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    let r = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return r == 0
}
