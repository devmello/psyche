import Foundation
import PsycheHelperCore
import PsycheProtocol

/// L7 image pipeline (spike 06 recipe, steps 1–9): create from an IPSW, provision on first boot,
/// install Psyche over SSH, stop, pre-grant TCC offline, export. Run by
/// `deploy/macos/build-guest-image.sh` through `psyche-helper guest-image build` in a throwaway
/// `PSYCHE_HOME`, so the owner's own sandbox Mac is untouched.
public enum GuestImageBuilder {
    public struct Options: Sendable {
        public var ipsw: String?
        public var download: Bool
        public var payload: String
        public var outDir: String
        public var id: String?
        public var cpus: Int?
        public var memoryGB: Int?
        public var diskGB: Int?

        public init(ipsw: String?, download: Bool, payload: String, outDir: String, id: String? = nil, cpus: Int? = nil, memoryGB: Int? = nil, diskGB: Int? = nil) {
            self.ipsw = ipsw
            self.download = download
            self.payload = payload
            self.outDir = outDir
            self.id = id
            self.cpus = cpus
            self.memoryGB = memoryGB
            self.diskGB = diskGB
        }
    }

    public static let guestName = "image"

    public static func build(
        _ vm: VMManager, _ o: Options, attempts: Int = 60, interval: TimeInterval = 10, emit: @escaping @Sendable (JSONValue) async -> Void
    ) async throws -> JSONValue {
        let name = guestName
        _ = try await vm.create(
            .init(name: name, cpus: o.cpus, memoryGB: o.memoryGB, diskGB: o.diskGB, ipsw: o.ipsw, download: o.download), emit: emit
        )
        _ = try await vm.start(name: name, emit: emit)
        // SSH comes up ~40 s after the provisioning boot (spike 06); the guest IP a little later.
        var installed = false
        for i in 0..<attempts where !installed {
            do {
                _ = try await vm.installPsyche(name: name, payload: o.payload, emit: emit)
                installed = true
            } catch let e as CapabilityError where e.retryable && i < attempts - 1 {
                try await _Concurrency.Task.sleep(nanoseconds: UInt64(interval * 1e9))
            }
        }
        _ = try await vm.stop(name: name, force: false)
        _ = try await vm.grantPermissions(name: name, payload: o.payload, emit: emit)
        return try await vm.exportImage(.init(name: name, outDir: o.outDir, id: o.id), emit: emit)
    }
}

/// `psyche-helper guest-image build|verify …` (L7). Offline: no Gateway; progress on stderr, the
/// result as JSON on stdout.
public enum GuestImageCLI {
    static let usage = """
        usage: psyche-helper guest-image build (--ipsw <path> | --download) --payload <dir> --out <dir> [--id <id>] [--cpus N] [--memory GB] [--disk GB]
               psyche-helper guest-image verify <image dir> [--sha256 <manifest sha256>]
        """

    public static func run(_ args: [String], log: HelperLog) -> Never {
        guard let sub = args.first, ["build", "verify"].contains(sub) else { fail(usage, code: 64) }
        var rest = Array(args.dropFirst())
        var flags: [String: String] = [:]
        var positional: [String] = []
        while !rest.isEmpty {
            let a = rest.removeFirst()
            if a == "--download" { flags["download"] = "1"; continue }
            if a.hasPrefix("--") {
                guard !rest.isEmpty else { fail(usage, code: 64) }
                flags[String(a.dropFirst(2))] = rest.removeFirst()
            } else {
                positional.append(a)
            }
        }
        let emit: @Sendable (JSONValue) async -> Void = { e in
            FileHandle.standardError.write(Data("\(e.jsonString(pretty: false))\n".utf8))
        }
        if sub == "verify" {
            guard let path = positional.first else { fail(usage, code: 64) }
            do {
                let m = try GuestImage.verify(URL(fileURLWithPath: path), expectedManifestSha256: flags["sha256"])
                print((try JSONValue(encoding: m)).jsonString(pretty: true))
                exit(0)
            } catch { fail(describe(error), code: 1) }
        }
        guard let payload = flags["payload"], let out = flags["out"], flags["ipsw"] != nil || flags["download"] != nil else { fail(usage, code: 64) }
        let options = GuestImageBuilder.Options(
            ipsw: flags["ipsw"], download: flags["download"] != nil, payload: payload, outDir: out, id: flags["id"],
            cpus: flags["cpus"].flatMap(Int.init), memoryGB: flags["memory"].flatMap(Int.init), diskGB: flags["disk"].flatMap(Int.init)
        )
        let vm = VMManager(backend: VZBackend(), log: log)
        // Virtualization.framework works on the main queue: run the pipeline from a task and park
        // the main thread in dispatchMain.
        _Concurrency.Task {
            do {
                let result = try await GuestImageBuilder.build(vm, options, emit: emit)
                print(result.jsonString(pretty: true))
                exit(0)
            } catch { fail(describe(error), code: 1) }
        }
        dispatchMain()
    }

    static func describe(_ error: Error) -> String {
        (error as? CapabilityError).map { "\($0.reason): \($0.message)" } ?? String(describing: error)
    }

    static func fail(_ message: String, code: Int32) -> Never {
        FileHandle.standardError.write(Data("guest-image: \(message)\n".utf8))
        exit(code)
    }
}
