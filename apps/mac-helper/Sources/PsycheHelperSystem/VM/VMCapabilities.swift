import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `vm.*` (L1–L5): the one Psyche sandbox Mac. Creating, starting and sharing are owner actions
/// from Settings → Devices; the Gateway gates them like any write, and read-write shares need an
/// approval (`approvalId`).
public enum VMCapabilities {
    struct NameParams: Decodable { var name: String? }
    struct SnapshotRef: Decodable {
        var name: String?
        var snapshot: String
    }
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
        let caps = all(vm)
        // Intel Macs: the same capabilities, each answering why VM mode is unavailable.
        guard let reason = vm.backend.unavailableReason else { return caps }
        return caps.map { c in Capability(c.spec) { _ in throw reason } }
    }

    static func all(_ vm: VMManager) -> [any CapabilityHandler] {
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
                    "image": Schema.string("L7: absolute path to a prebuilt guest image (directory or .aar) instead of an IPSW"),
                    "imageSha256": Schema.string("Expected SHA-256 of the image's manifest.json, from the publisher", maxLength: 64),
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

            // L7 prebuilt images.
            Capability(CapabilitySpec(
                name: "vm.export_image",
                description: "Export the stopped, provisioned sandbox Mac as a prebuilt guest image in outDir/<id>/ (disk, auxiliary storage, hardware model, bootstrap credentials and a SHA-256 manifest). Never its machine identity. The image holds the guest password: share it only with people you trust.",
                sideEffect: .write, targetKind: .path,
                inputSchema: Schema.object([
                    "name": nameSchema, "outDir": Schema.string("Absolute host folder"), "id": Schema.string(maxLength: 64),
                ], required: ["outDir"]),
                streaming: true, receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(VMManager.ExportImageParams.self)
                let out = try await vm.exportImage(p, emit: ctx.emit)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Exported the sandbox Mac as a guest image"))
            },

            // L6 snapshots and resets.
            Capability(CapabilitySpec(
                name: "vm.snapshot",
                description: "Snapshot the stopped or saved sandbox Mac (APFS clones: instant, copy-on-write). kind base makes it the \"fresh Mac\" vm.reset returns to; task snapshots are pruned to the newest 3; at most 10 manual.",
                sideEffect: .write,
                inputSchema: Schema.object([
                    "name": nameSchema, "label": Schema.string(maxLength: 120), "kind": Schema.string(enum: ["base", "manual", "task"]),
                    "taskId": Schema.string(maxLength: 128),
                ]),
                streaming: true, receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(VMManager.SnapshotParams.self)
                let out = try await vm.snapshot(p, emit: ctx.emit)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Snapshot of the sandbox Mac"))
            },
            Capability(CapabilitySpec(
                name: "vm.restore",
                description: "Restore the stopped sandbox Mac to a snapshot. Discards the current disk (the snapshot is kept).",
                sideEffect: .destructive,
                inputSchema: Schema.object(["name": nameSchema, "snapshot": Schema.string(maxLength: 64)], required: ["snapshot"]),
                streaming: true, receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(SnapshotRef.self)
                let out = try await vm.restore(name: p.name ?? "sandbox", snapshot: p.snapshot, emit: ctx.emit)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Restored the sandbox Mac to a snapshot"))
            },
            Capability(CapabilitySpec(
                name: "vm.reset",
                description: "Reset the stopped sandbox Mac to its base snapshot (\"fresh Mac\"). Discards the current disk.",
                sideEffect: .destructive, inputSchema: Schema.object(["name": nameSchema]), streaming: true, receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(NameParams.self)
                let out = try await vm.reset(name: p.name ?? "sandbox", emit: ctx.emit)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Reset the sandbox Mac to a fresh Mac"))
            },
            Capability(CapabilitySpec(
                name: "vm.snapshot_delete", description: "Delete one snapshot of the sandbox Mac. Deleting the base leaves no reset point.",
                sideEffect: .destructive,
                inputSchema: Schema.object(["name": nameSchema, "snapshot": Schema.string(maxLength: 64)], required: ["snapshot"]),
                receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(SnapshotRef.self)
                let out = try await vm.deleteSnapshot(name: p.name ?? "sandbox", snapshot: p.snapshot)
                return CapabilityOutput(out, receipt: ReceiptDraft(outcome: .ok, summary: "Deleted a sandbox Mac snapshot"))
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

            Capability(CapabilitySpec(
                name: "vm.pause", description: "Pause a running sandbox Mac in memory.", sideEffect: .write,
                inputSchema: Schema.object(["name": nameSchema]), receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(NameParams.self)
                return CapabilityOutput(try await vm.pause(name: p.name ?? "sandbox"), receipt: ReceiptDraft(outcome: .ok, summary: "Paused the sandbox Mac"))
            },

            Capability(CapabilitySpec(
                name: "vm.resume", description: "Resume a paused sandbox Mac.", sideEffect: .write,
                inputSchema: Schema.object(["name": nameSchema]), receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(NameParams.self)
                return CapabilityOutput(try await vm.resume(name: p.name ?? "sandbox"), receipt: ReceiptDraft(outcome: .ok, summary: "Resumed the sandbox Mac"))
            },

            Capability(CapabilitySpec(
                name: "vm.suspend",
                description: "Save the machine state and stop (warm start on the next vm.start). Unproven on macOS 27.0.1 (spike 06): a failure leaves the guest running.",
                sideEffect: .write, inputSchema: Schema.object(["name": nameSchema]), receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(NameParams.self)
                return CapabilityOutput(try await vm.suspend(name: p.name ?? "sandbox"), receipt: ReceiptDraft(outcome: .ok, summary: "Saved and stopped the sandbox Mac"))
            },

            Capability(CapabilitySpec(
                name: "vm.configure",
                description: "Change resources (cpus, memoryGB) and display size while stopped; clipboard (off, paste-only, bidirectional) and credential placement (host, guest) any time.",
                sideEffect: .write,
                inputSchema: Schema.object([
                    "name": nameSchema, "cpus": Schema.integer(min: VMConfig.minCPUs, max: 32), "memoryGB": Schema.integer(min: VMConfig.minMemoryGB, max: 256),
                    "displayWidth": Schema.integer(min: 640, max: 3840), "displayHeight": Schema.integer(min: 480, max: 2400),
                    "clipboard": Schema.string(enum: ["off", "paste-only", "bidirectional"]), "vault": Schema.string(enum: ["host", "guest"]),
                ]),
                receiptKind: "vm"
            )) { ctx in
                let p = try ctx.decode(VMManager.ConfigureParams.self)
                return CapabilityOutput(try vm.configure(p), receipt: ReceiptDraft(outcome: .ok, summary: "Changed the sandbox Mac's settings"))
            },

            Capability(CapabilitySpec(
                name: "vm.display", description: "Show or hide the guest's display window on the host (Take control).",
                sideEffect: .write, inputSchema: Schema.object(["name": nameSchema, "visible": Schema.boolean()], required: ["visible"]), receiptKind: "vm"
            )) { ctx in
                struct P: Decodable {
                    var name: String?
                    var visible: Bool
                }
                let p = try ctx.decode(P.self)
                return CapabilityOutput(try await vm.setDisplay(name: p.name ?? "sandbox", visible: p.visible),
                                        receipt: ReceiptDraft(outcome: .ok, summary: p.visible ? "Showed the guest display" : "Hid the guest display"))
            },

            Capability(CapabilitySpec(
                name: "vm.agent_status", description: "Ping the guest helper over vsock 7000: version and its Accessibility / Screen Recording state.",
                sideEffect: .read, inputSchema: Schema.object(["name": nameSchema])
            )) { ctx in
                let p = try ctx.decode(NameParams.self)
                return CapabilityOutput(try await vm.ping(name: p.name ?? "sandbox"))
            },

            Capability(CapabilitySpec(
                name: "vm.copy_in",
                description: "Copy a host file or folder into the guest (read-only at /Volumes/My Shared Files/psyche-in/<id>/). Sensitive folders are refused.",
                sideEffect: .write, targetKind: .path,
                inputSchema: Schema.object(["name": nameSchema, "hostPath": Schema.string()], required: ["hostPath"]), receiptKind: "vm_transfer"
            )) { ctx in
                struct P: Decodable {
                    var name: String?
                    var hostPath: String
                }
                let p = try ctx.decode(P.self)
                let (t, guest) = try vm.copyIn(name: p.name ?? "sandbox", hostPath: p.hostPath)
                return CapabilityOutput(["transfer": try JSONValue(encoding: t), "guest": guest],
                                        receipt: ReceiptDraft(outcome: .ok, summary: "Copied \(URL(fileURLWithPath: t.hostPath).lastPathComponent) into the guest",
                                                              externalRefs: ["transfer": .string(t.id), "bytes": .int(t.bytes)]))
            },

            Capability(CapabilitySpec(
                name: "vm.copy_out",
                description: "Copy one guest file to a host folder inside the granted folders (never overwrites). The guest helper stages it in the _psyche-out share.",
                sideEffect: .write, targetKind: .path,
                inputSchema: Schema.object(["name": nameSchema, "guestPath": Schema.string(), "hostDir": Schema.string()], required: ["guestPath", "hostDir"]),
                receiptKind: "vm_transfer"
            )) { ctx in
                struct P: Decodable {
                    var name: String?
                    var guestPath: String
                    var hostDir: String
                }
                let p = try ctx.decode(P.self)
                let (t, guest) = try await vm.copyOut(name: p.name ?? "sandbox", guestPath: p.guestPath, hostDir: p.hostDir)
                return CapabilityOutput(["transfer": try JSONValue(encoding: t), "guest": guest],
                                        receipt: ReceiptDraft(outcome: .ok, summary: "Copied \(URL(fileURLWithPath: t.hostPath).lastPathComponent) to the host",
                                                              externalRefs: ["transfer": .string(t.id), "bytes": .int(t.bytes)]))
            },

            Capability(CapabilitySpec(
                name: "vm.install_psyche",
                description: "Install Psyche in the running guest from a release or checkout (shared read-only), over SSH: psyche-node (vsock 2:7980) and the guest helper (vsock 7000 agent).",
                sideEffect: .write,
                inputSchema: Schema.object(["name": nameSchema, "payload": Schema.string("Absolute host path of a Psyche release or checkout")], required: ["payload"]),
                streaming: true, receiptKind: "vm"
            )) { ctx in
                struct P: Decodable {
                    var name: String?
                    var payload: String
                }
                let p = try ctx.decode(P.self)
                return CapabilityOutput(try await vm.installPsyche(name: p.name ?? "sandbox", payload: p.payload, emit: ctx.emit),
                                        receipt: ReceiptDraft(outcome: .ok, summary: "Installed Psyche in the sandbox Mac"))
            },

            Capability(CapabilitySpec(
                name: "vm.grant_permissions",
                description: "Pre-grant Accessibility and Screen Recording to the guest helper by writing the stopped guest's TCC.db offline (SIP blocks in-guest writes).",
                sideEffect: .write,
                inputSchema: Schema.object(["name": nameSchema, "payload": Schema.string("The payload whose Psyche Helper.app was installed")], required: ["payload"]),
                streaming: true, receiptKind: "vm"
            )) { ctx in
                struct P: Decodable {
                    var name: String?
                    var payload: String
                }
                let p = try ctx.decode(P.self)
                return CapabilityOutput(try await vm.grantPermissions(name: p.name ?? "sandbox", payload: p.payload, emit: ctx.emit),
                                        receipt: ReceiptDraft(outcome: .ok, summary: "Granted the guest helper Accessibility and Screen Recording"))
            },

            Capability(CapabilitySpec(
                name: "vm.watch",
                description: "Long-lived stream of {type: vm.updated, guest, at} and {type: vm.deleted, name} events, for the Gateway's vm.updated broadcast.",
                sideEffect: .read, streaming: true
            )) { ctx in
                let (id, stream) = vm.events.subscribe()
                defer { vm.events.unsubscribe(id) }
                await ctx.emit(["type": "vm.status", "status": vm.status()])
                for await event in stream {
                    if _Concurrency.Task.isCancelled { break }
                    await ctx.emit(event)
                }
                return CapabilityOutput(["closed": true])
            },
        ]
    }
}
