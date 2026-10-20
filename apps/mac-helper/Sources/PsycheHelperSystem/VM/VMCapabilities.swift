import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `vm.*` (L1–L5): the one Psyche sandbox Mac. Creating, starting and sharing are owner actions
/// from Settings → Devices; the Gateway gates them like any write, and read-write shares need an
/// approval (`approvalId`).
public enum VMCapabilities {
    struct NameParams: Decodable { var name: String? }
    struct StopParams: Decodable {
        var name: String?
        var force: Bool?
    }
    struct ShareParams: Decodable {
        var name: String?
        var share: String
        var path: String?
        var readOnly: Bool?
    }

    static let nameSchema = Schema.string("Guest name (default \"sandbox\")", maxLength: 32)

    public static func make(_ vm: VMManager) -> [any CapabilityHandler] {
        [
            Capability(CapabilitySpec(
                name: "vm.status", description: "The sandbox Mac(s): phase, resources, guest macOS, shares, vsock ports; whether unattended provisioning is available.",
                sideEffect: .read
            )) { _ in CapabilityOutput(vm.status()) },

            Capability(CapabilitySpec(
                name: "vm.restore_image", description: "The latest macOS restore image this Mac supports (version, build, download size). Contacts Apple's catalog.",
                sideEffect: .read
            )) { _ in
                let i = try await vm.backend.latestRestoreImage()
                return CapabilityOutput(["version": .string(i.version), "build": .string(i.build), "sizeBytes": i.sizeBytes.map { .number(Double($0)) } ?? .null])
            },

            Capability(CapabilitySpec(
                name: "vm.create",
                description: "Create the sandbox Mac from a local IPSW or the latest restore image (download: true confirms the ~26 GB download), then install macOS. Streams vm.download / vm.install progress. One guest per user.",
                sideEffect: .write,
                inputSchema: Schema.object([
                    "name": nameSchema, "cpus": Schema.integer(min: VMConfig.minCPUs, max: 32), "memoryGB": Schema.integer(min: VMConfig.minMemoryGB, max: 256),
                    "diskGB": Schema.integer(min: VMConfig.minDiskGB, max: 2048), "ipsw": Schema.string("Absolute path to a local IPSW"),
                    "download": Schema.boolean("Confirm downloading the latest restore image"), "username": Schema.string(maxLength: 32),
                ]),
                streaming: true, receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(VMManager.CreateParams.self)
                let out = try await vm.create(p, emit: ctx.emit)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Created the sandbox Mac \(p.name ?? "sandbox")"))
            },

            Capability(CapabilitySpec(
                name: "vm.start",
                description: "Boot the sandbox Mac headless. The first boot provisions the admin user, auto-login and Remote Login unattended (macOS 27 host and guest). Guest psyche-node reaches the Gateway over vsock (host CID 2, port 7980) and pairs like any node.",
                sideEffect: .write, inputSchema: Schema.object(["name": nameSchema]), streaming: true, receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(NameParams.self)
                let out = try await vm.start(name: p.name ?? "sandbox", emit: ctx.emit)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Started the sandbox Mac"))
            },

            Capability(CapabilitySpec(
                name: "vm.stop",
                description: "Shut the sandbox Mac down through the guest helper; force: true stops it hard if the guest does not respond (risks fsck on next boot).",
                sideEffect: .write, inputSchema: Schema.object(["name": nameSchema, "force": Schema.boolean()]), receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(StopParams.self)
                let out = try await vm.stop(name: p.name ?? "sandbox", force: p.force ?? false)
                let graceful = out["graceful"]?.boolValue ?? true
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: graceful ? "Stopped the sandbox Mac" : "Force-stopped the sandbox Mac"))
            },

            Capability(CapabilitySpec(
                name: "vm.delete", description: "Delete a stopped sandbox Mac and its disk. Cannot be undone.",
                sideEffect: .destructive, inputSchema: Schema.object(["name": nameSchema]), receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(NameParams.self)
                let out = try await vm.delete(name: p.name ?? "sandbox")
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Deleted the sandbox Mac"))
            },

            Capability(CapabilitySpec(
                name: "vm.share_add",
                description: "Share one host folder with the guest at /Volumes/Psyche Shares/<share>. Read-only by default; read-write needs an approval. Never /, the home folder, ~/Library or Psyche's data. Applied live to a running guest.",
                sideEffect: .write, targetKind: .path,
                inputSchema: Schema.object([
                    "name": nameSchema, "share": Schema.string("Share name", maxLength: 64), "path": Schema.string("Absolute host folder"),
                    "readOnly": Schema.boolean("Default true"),
                ], required: ["share", "path"]),
                receiptKind: "vm_share"
            )) { ctx in
                let p = try ctx.decode(ShareParams.self)
                guard let path = p.path else { throw CapabilityError.invalidParams("path is required", field: "path") }
                let ro = p.readOnly ?? true
                let out = try await vm.addShare(name: p.name ?? "sandbox", share: p.share, path: path, readOnly: ro, approvalId: ctx.approvalId)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Shared \(p.share) \(ro ? "read-only" : "read-write")", externalRefs: ["share": .string(p.share)]))
            },

            Capability(CapabilitySpec(
                name: "vm.share_remove", description: "Stop sharing a folder (applied live to a running guest).",
                sideEffect: .write, targetKind: .path,
                inputSchema: Schema.object(["name": nameSchema, "share": Schema.string(maxLength: 64)], required: ["share"]), receiptKind: "vm_share"
            )) { ctx in
                let p = try ctx.decode(ShareParams.self)
                let out = try await vm.removeShare(name: p.name ?? "sandbox", share: p.share)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Stopped sharing \(p.share)"))
            },
        ]
    }
}
