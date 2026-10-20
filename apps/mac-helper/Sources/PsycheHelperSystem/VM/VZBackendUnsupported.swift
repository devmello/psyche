import Foundation
import PsycheHelperCore
import PsycheProtocol

#if !arch(arm64)
/// Intel Macs cannot run macOS guests: Virtualization.framework's macOS VM classes are Apple
/// silicon only. Every `vm.*` capability answers `unavailable/vm_unsupported_arch`, which the
/// Gateway and Settings show as "VM mode is unavailable on this Mac".
public final class VZBackend: VMBackend, @unchecked Sendable {
    public init() {}

    public var unavailableReason: CapabilityError? { Self.unsupported }

    static let unsupported = CapabilityError(
        .unavailable, reason: "vm_unsupported_arch", "A sandbox Mac needs a Mac with Apple silicon; this Mac has an Intel processor."
    )

    public var supportsGuestProvisioning: Bool { false }
    public var activeCount: Int { 0 }
    public func isRunning(_ name: String) -> Bool { false }
    public func isPaused(_ name: String) -> Bool { false }
    public func isDisplayVisible(_ name: String) -> Bool { false }
    public func latestRestoreImage() async throws -> RestoreImageInfo { throw Self.unsupported }
    public func loadRestoreImage(_ url: URL) async throws -> RestoreImageInfo { throw Self.unsupported }
    public func download(_ image: RestoreImageInfo, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws { throw Self.unsupported }
    public func prepareBundle(_ bundle: VMBundle, config: VMConfig, image: URL) async throws { throw Self.unsupported }
    public func install(_ bundle: VMBundle, config: VMConfig, image: URL, progress: @escaping @Sendable (Double) -> Void) async throws { throw Self.unsupported }
    public func prepareImported(_ bundle: VMBundle, config: VMConfig) async throws { throw Self.unsupported }
    public func start(
        _ bundle: VMBundle, config: VMConfig, shares: [ShareGrant], system: VMSystemShares, provisioning: GuestProvisioning?,
        restoreFrom: URL?, onGatewayConnection: @escaping @Sendable (Int32) -> Void, onStop: @escaping @Sendable (String?) -> Void
    ) async throws { throw Self.unsupported }
    public func stop(_ name: String, force: Bool) async throws -> Bool { throw Self.unsupported }
    public func pause(_ name: String) async throws { throw Self.unsupported }
    public func resume(_ name: String) async throws { throw Self.unsupported }
    public func saveState(_ name: String, to url: URL) async throws { throw Self.unsupported }
    public func setShares(_ name: String, shares: [ShareGrant], system: VMSystemShares) async throws { throw Self.unsupported }
    public func setDisplay(_ name: String, visible: Bool) async throws { throw Self.unsupported }
    public func connectGuestAgent(_ name: String) async throws -> Int32 { throw Self.unsupported }
}
#endif
