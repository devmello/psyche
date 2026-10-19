import Foundation
import Virtualization

let usage = """
vzspike — spike-06: a macOS guest created and provisioned without a GUI.

  fetch-ipsw [--out <file>] [--url-only]       VZMacOSRestoreImage.fetchLatestSupported, then download
  create <bundle> --ipsw <file>|--from-catalog [--cpus 4] [--memory-gb 8] [--disk-gb 80] [--format asif|raw]
  install <bundle>                             VZMacOSInstaller from the bundle's IPSW
  provision <bundle> --user <u> --password <p> [--full-name <n>] [--after-ssh <script>] [--window]
                                               first boot with VZMacGuestProvisioningOptions (27 guest)
  start <bundle> [--window] [--restore-state] [--recovery] [--after-ssh <script>]
  share <bundle> <tag> <name> <path> ro|rw     add/replace a directory on a running VirtioFS device
  share-config <bundle> <tag> <name> <path> ro|rw   add a share to config.json (takes effect at next start)
  vsock-echo <bundle> <port> <message>         host → guest request over virtio-vsock
  save <bundle>                                pause + saveMachineStateTo, then stop
  snapshot <bundle> --name <n> [--mode overlay|apfs]
  restore <bundle> --name <n>
  overlay-reset <bundle>                       drop the writable top overlay ("fresh Mac")
  stop <bundle> [--force]
  status <bundle>
  sizes <bundle>                               allocated bytes of every file in the bundle
  datavol-provision <bundle> --user <u> --password <p> [--full-name <n>]
                                               offline user/autologin/SSH on the Data volume (pre-27 guests)
  datavol-tcc <bundle> --client <guest path> [--csreq-hex <hex>] [--services a,b]
                                               offline TCC.db pre-grant (default: Accessibility + ScreenCapture)
  datavol-mount <bundle>                       attach + mount the Data volume and leave it mounted
"""

var args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { print(usage); exit(64) }
args.removeFirst()

func flag(_ name: String) -> Bool {
    if let i = args.firstIndex(of: name) { args.remove(at: i); return true }
    return false
}

func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let v = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return v
}

func positional(_ what: String) -> String {
    guard !args.isEmpty else { fail("missing \(what)\n\(usage)") }
    return args.removeFirst()
}

func randomMAC() -> String { VZMACAddress.randomLocallyAdministered().string }

func hostVersion() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

/// Waits on the main run loop for an async VZ callback.
func block<T>(_ body: (@escaping (T) -> Void) -> Void) -> T {
    var result: T?
    body { result = $0 }
    while result == nil { RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1)) }
    return result!
}

switch cmd {
case "fetch-ipsw":
    let out = opt("--out") ?? "~/.psyche-spike06/ipsw/latest.ipsw"
    let urlOnly = flag("--url-only")
    let r: Result<VZMacOSRestoreImage, Error> = block { done in VZMacOSRestoreImage.fetchLatestSupported { done($0) } }
    guard case .success(let img) = r else { fail("fetchLatestSupported: \(r)") }
    let v = img.operatingSystemVersion
    print("latest supported: \(v.majorVersion).\(v.minorVersion).\(v.patchVersion) (\(img.buildVersion)) \(img.url)")
    if urlOnly { exit(0) }
    // URLSession download with progress; curl -C - is the resumable alternative used in the write-up.
    let dest = URL(fileURLWithPath: (out as NSString).expandingTildeInPath)
    try? FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
    let t = now()
    let task = URLSession.shared.downloadTask(with: img.url) { tmp, _, err in
        if let err { fail("download: \(err)") }
        try? FileManager.default.removeItem(at: dest)
        do { try FileManager.default.moveItem(at: tmp!, to: dest) } catch { fail("move: \(error)") }
        print(String(format: "downloaded %@ in %.0f s", dest.path, now() - t))
        exit(0)
    }
    let obs = task.progress.observe(\.fractionCompleted) { p, _ in
        log(String(format: "download %.1f%%", p.fractionCompleted * 100))
    }
    task.resume()
    _ = obs
    RunLoop.main.run()

case "create":
    let bundle = VMBundle(positional("bundle"))
    // --from-catalog: take the hardware model from the catalog entry without downloading the
    // IPSW (blank bundles for the concurrency-cap and overlay tests; they cannot be installed).
    let fromCatalog = flag("--from-catalog")
    let ipsw = opt("--ipsw")
    guard ipsw != nil || fromCatalog else { fail("--ipsw or --from-catalog required") }
    let ipswURL = URL(fileURLWithPath: ((ipsw ?? "/dev/null") as NSString).expandingTildeInPath)
    let cpus = Int(opt("--cpus") ?? "4")!
    let mem = Int(opt("--memory-gb") ?? "8")!
    let diskGB = Int(opt("--disk-gb") ?? "80")!
    let format = opt("--format") ?? "asif"
    let t = now()
    let r: Result<VZMacOSRestoreImage, Error> = block { done in
        if fromCatalog { VZMacOSRestoreImage.fetchLatestSupported { done($0) } }
        else { VZMacOSRestoreImage.load(from: ipswURL) { done($0) } }
    }
    guard case .success(let img) = r else { fail("load restore image: \(r)") }
    guard let req = img.mostFeaturefulSupportedConfiguration else { fail("IPSW not supported on this host") }
    guard req.hardwareModel.isSupported else { fail("hardware model unsupported") }
    try FileManager.default.createDirectory(at: bundle.root, withIntermediateDirectories: true)
    try req.hardwareModel.dataRepresentation.write(to: bundle.hardwareModelURL)
    try VZMacMachineIdentifier().dataRepresentation.write(to: bundle.machineIdentifierURL)
    _ = try VZMacAuxiliaryStorage(creatingStorageAt: bundle.auxStorageURL, hardwareModel: req.hardwareModel, options: [])
    let v = img.operatingSystemVersion
    var cfg = VMConfig(cpus: max(cpus, req.minimumSupportedCPUCount), memoryGB: max(mem, Int(req.minimumSupportedMemorySize >> 30)),
                       diskGB: diskGB, diskFormat: format, macAddress: randomMAC(),
                       ipswPath: ipswURL.path, ipswBuild: img.buildVersion,
                       guestOS: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", createdOnHost: hostVersion())
    cfg.shares = []
    try Disk.createBase(bundle.baseDiskURL(cfg), gb: diskGB, format: format)
    try bundle.saveConfig(cfg)
    bundle.recordTiming("create", seconds: now() - t, extra: ["format": format, "guest": cfg.guestOS])
    print("created \(bundle.root.path): guest \(cfg.guestOS) (\(img.buildVersion)), \(cfg.cpus) CPU, \(cfg.memoryGB) GB, \(diskGB) GB \(format), MAC \(cfg.macAddress)")
    print("min CPU \(req.minimumSupportedCPUCount), min memory \(req.minimumSupportedMemorySize >> 20) MB")

case "install":
    let bundle = VMBundle(positional("bundle"))
    let cfg = try bundle.loadConfig()
    var b = MachineBuilder(bundle: bundle, cfg: cfg)
    let vm = VZVirtualMachine(configuration: try b.build(withShares: false))
    let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: cfg.ipswPath))
    var last = -1
    let obs = installer.progress.observe(\.fractionCompleted, options: [.new]) { p, _ in
        let pct = Int(p.fractionCompleted * 100)
        if pct != last { last = pct; log("install \(pct)%") }
    }
    let t = now()
    let r: Result<Void, Error> = block { done in installer.install { done($0) } }
    _ = obs
    if case .failure(let e) = r { fail("install: \(e)") }
    bundle.recordTiming("install", seconds: now() - t, extra: ["guest": cfg.guestOS, "format": cfg.diskFormat])
    _ = b
    print(String(format: "installed %@ in %.0f s", cfg.guestOS, now() - t))

case "provision":
    let bundle = VMBundle(positional("bundle"))
    var cfg = try bundle.loadConfig()
    let p = VZMacGuestProvisioningOptions()
    p.username = opt("--user") ?? "psyche"
    guard let password = opt("--password") else { fail("--password required") }
    p.password = password
    p.fullName = opt("--full-name") ?? "Psyche"
    p.logsInAutomatically = true
    p.enablesRemoteLogin = true
    do { try p.validate() } catch { fail("provisioning options invalid: \(error)") }
    cfg.username = p.username
    try bundle.saveConfig(cfg)
    var o = StartOptions()
    o.provisioning = p
    o.window = flag("--window")
    o.afterSSH = opt("--after-ssh")
    o.waitForSSH = true
    o.stopAfterScript = flag("--stop-after")
    Runner(bundle: bundle, cfg: cfg, opts: o).run()

case "start":
    let bundle = VMBundle(positional("bundle"))
    let cfg = try bundle.loadConfig()
    var o = StartOptions()
    o.window = flag("--window")
    o.restoreState = flag("--restore-state")
    o.recovery = flag("--recovery")
    o.afterSSH = opt("--after-ssh")
    o.stopAfterScript = flag("--stop-after")
    Runner(bundle: bundle, cfg: cfg, opts: o).run()

case "share":
    let bundle = VMBundle(positional("bundle"))
    let tag = positional("tag"), name = positional("name"), path = positional("path"), mode = positional("ro|rw")
    print(controlRequest(bundle.controlSocket, "share \(tag) \(name) \((path as NSString).expandingTildeInPath) \(mode)"))

case "share-config":
    let bundle = VMBundle(positional("bundle"))
    var cfg = try bundle.loadConfig()
    let tag = positional("tag"), name = positional("name"), path = positional("path"), mode = positional("ro|rw")
    cfg.shares.removeAll { $0.tag == tag && $0.name == name }
    cfg.shares.append(ShareSpec(tag: tag, name: name, path: (path as NSString).expandingTildeInPath, readOnly: mode != "rw"))
    try bundle.saveConfig(cfg)
    print("shares: \(cfg.shares)")

case "vsock-echo":
    let bundle = VMBundle(positional("bundle"))
    let port = positional("port")
    print(controlRequest(bundle.controlSocket, "vsock \(port) \(args.joined(separator: " "))"))

case "save":
    let bundle = VMBundle(positional("bundle"))
    let path = args.first.map { " " + ($0 as NSString).expandingTildeInPath } ?? ""
    print(controlRequest(bundle.controlSocket, "save" + path))

case "stop":
    let bundle = VMBundle(positional("bundle"))
    print(controlRequest(bundle.controlSocket, flag("--force") ? "kill" : "stop"))

case "status":
    let bundle = VMBundle(positional("bundle"))
    print(controlRequest(bundle.controlSocket, "status", timeout: 5))

case "snapshot":
    let bundle = VMBundle(positional("bundle"))
    guard let name = opt("--name") else { fail("--name required") }
    let mode = opt("--mode") ?? "overlay"
    guard controlRequest(bundle.controlSocket, "status", timeout: 2).hasPrefix("ERR") else { fail("stop the VM first") }
    var cfg = try bundle.loadConfig()
    var snaps = bundle.loadSnapshots()
    let t = now()
    let auxRel = "snapshots/\(name).aux"
    try Disk.clone(bundle.auxStorageURL, bundle.url(auxRel))
    if mode == "apfs" {
        guard cfg.layers.isEmpty && cfg.topOverlay == nil else { fail("apfs mode snapshots the base disk; drop overlays first") }
        let rel = "snapshots/\(name).disk"
        try Disk.clone(bundle.baseDiskURL(cfg), bundle.url(rel))
        snaps[name] = SnapshotRecord(mode: "apfs", layers: [], disk: rel, aux: auxRel, created: Date())
    } else {
        guard cfg.diskFormat == "asif" else { fail("overlay snapshots need an ASIF base") }
        // Freeze the current top (if any) and start a new empty overlay above it.
        if let top = cfg.topOverlay { cfg.layers.append(top) }
        snaps[name] = SnapshotRecord(mode: "overlay", layers: cfg.layers, disk: nil, aux: auxRel, created: Date())
        cfg.topOverlay = try Disk.createOverlay(bundle: bundle, cfg: cfg)
    }
    try bundle.saveConfig(cfg)
    try bundle.saveSnapshots(snaps)
    bundle.recordTiming("snapshot-\(mode)", seconds: now() - t, extra: ["name": name])
    print(String(format: "snapshot %@ (%@) in %.3f s; layers=%@ top=%@", name, mode, now() - t, cfg.layers, cfg.topOverlay ?? "-"))

case "restore", "overlay-reset":
    let bundle = VMBundle(positional("bundle"))
    guard controlRequest(bundle.controlSocket, "status", timeout: 2).hasPrefix("ERR") else { fail("stop the VM first") }
    var cfg = try bundle.loadConfig()
    let snaps = bundle.loadSnapshots()
    let t = now()
    let fm = FileManager.default
    if cmd == "overlay-reset" {
        guard let top = cfg.topOverlay else { fail("no top overlay") }
        try fm.removeItem(at: bundle.url(top))
        cfg.topOverlay = try Disk.createOverlay(bundle: bundle, cfg: cfg)
        try? fm.removeItem(at: bundle.stateURL)
        try bundle.saveConfig(cfg)
        bundle.recordTiming("overlay-reset", seconds: now() - t)
        print(String(format: "overlay reset in %.3f s (NVRAM kept)", now() - t))
        exit(0)
    }
    guard let name = opt("--name"), let s = snaps[name] else { fail("unknown snapshot") }
    try Disk.clone(bundle.url(s.aux), bundle.auxStorageURL)
    if s.mode == "apfs" {
        try Disk.clone(bundle.url(s.disk!), bundle.baseDiskURL(cfg))
        cfg.layers = []; cfg.topOverlay = nil
    } else {
        let referenced = Set(snaps.values.flatMap { $0.layers })
        for l in cfg.layers.dropFirst(s.layers.count) where !referenced.contains(l) { try? fm.removeItem(at: bundle.url(l)) }
        if let top = cfg.topOverlay { try? fm.removeItem(at: bundle.url(top)) }
        cfg.layers = s.layers
        cfg.topOverlay = try Disk.createOverlay(bundle: bundle, cfg: cfg)
    }
    // A saved machine state no longer matches the disk.
    try? fm.removeItem(at: bundle.stateURL)
    try bundle.saveConfig(cfg)
    bundle.recordTiming("restore-\(s.mode)", seconds: now() - t, extra: ["name": name])
    print(String(format: "restored %@ (%@) in %.3f s", name, s.mode, now() - t))

case "sizes":
    let bundle = VMBundle(positional("bundle"))
    let e = FileManager.default.enumerator(at: bundle.root, includingPropertiesForKeys: nil)!
    var total: Int64 = 0
    for case let u as URL in e {
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir)
        if isDir.boolValue { continue }
        let a = Disk.allocatedBytes(u)
        let logical = (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        total += a
        print(String(format: "%10.1f MB allocated  %10.1f MB logical  %@", Double(a) / 1e6, Double(logical) / 1e6,
                     String(u.path.dropFirst(bundle.root.path.count + 1))))
    }
    print(String(format: "%10.1f MB total allocated (APFS clones are counted in full here)", Double(total) / 1e6))

case "datavol-provision", "datavol-tcc", "datavol-mount":
    let bundle = VMBundle(positional("bundle"))
    let cfg = try bundle.loadConfig()
    guard controlRequest(bundle.controlSocket, "status", timeout: 2).hasPrefix("ERR") else { fail("stop the VM first") }
    guard cfg.layers.isEmpty && cfg.topOverlay == nil else { fail("datavol edits operate on the base disk; run them before overlay snapshots") }
    let dv = DataVolume(image: bundle.baseDiskURL(cfg))
    let t = now()
    try dv.attach()
    if cmd == "datavol-mount" { print("mounted at \(dv.mountPoint.path) (eject with: diskutil eject \(dv.wholeDisk))"); exit(0) }
    defer { dv.detach() }
    do {
        if cmd == "datavol-provision" {
            guard let pw = opt("--password") else { fail("--password required") }
            let user = opt("--user") ?? "psyche"
            try dv.provisionUser(username: user, fullName: opt("--full-name") ?? "Psyche", password: pw,
                                 guestBuild: cfg.ipswBuild, guestVersion: cfg.guestOS)
            var c = cfg; c.username = user; try bundle.saveConfig(c)
        } else {
            guard let client = opt("--client") else { fail("--client required") }
            let services = (opt("--services") ?? "kTCCServiceAccessibility,kTCCServiceScreenCapture").split(separator: ",").map(String.init)
            print(try dv.grantTCC(client: client, csreqHex: opt("--csreq-hex"), services: services))
        }
    } catch {
        dv.detach()
        fail("\(cmd): \(error)")
    }
    bundle.recordTiming(cmd, seconds: now() - t)

default:
    print(usage)
    exit(64)
}
