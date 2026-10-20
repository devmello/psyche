import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Host folders the system shares beside the user's grants (spike 06 "Shared folders"):
/// the automount tag carries the read-only Psyche payload and the copy-in staging folder; the
/// `psyche` tag carries `_psyche-out`, the only folder the guest helper may write for copy-out.
public struct VMSystemShares: Sendable, Equatable {
    public var payload: URL?
    public var transferIn: URL
    public var transferOut: URL

    public init(payload: URL? = nil, transferIn: URL, transferOut: URL) {
        self.payload = payload
        self.transferIn = transferIn
        self.transferOut = transferOut
    }

    public static func of(_ bundle: VMBundle, payload: URL? = nil) -> VMSystemShares {
        VMSystemShares(payload: payload, transferIn: bundle.transferInURL, transferOut: bundle.transferOutURL)
    }
}

/// Virtualization.framework behind a seam, so lifecycle, caps, shares, the agent channel and
/// forwarding are tested with a fake (no restore image is downloaded and no guest boots in CI or
/// on dev machines).
public protocol VMBackend: AnyObject, Sendable {
    /// GUI-free provisioning is available (macOS 27 host; the guest must be 27 too).
    var supportsGuestProvisioning: Bool { get }
    func latestRestoreImage() async throws -> RestoreImageInfo
    func loadRestoreImage(_ url: URL) async throws -> RestoreImageInfo
    func download(_ image: RestoreImageInfo, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws
    /// Writes HardwareModel, MachineIdentifier, AuxiliaryStorage and the empty disk.
    func prepareBundle(_ bundle: VMBundle, config: VMConfig, image: URL) async throws
    func install(_ bundle: VMBundle, config: VMConfig, image: URL, progress: @escaping @Sendable (Double) -> Void) async throws
    /// L7: an imported bundle (disk, auxiliary storage and hardware model copied from an image)
    /// gets a fresh MachineIdentifier; throws `image_unsupported` when this Mac cannot run its
    /// hardware model.
    func prepareImported(_ bundle: VMBundle, config: VMConfig) async throws
    /// Boots the guest headless, cold or from `restoreFrom` (a saved machine state). Every guest
    /// connection to `VsockPorts.gatewayNode` is handed to `onGatewayConnection` as a descriptor
    /// the callee owns.
    func start(
        _ bundle: VMBundle, config: VMConfig, shares: [ShareGrant], system: VMSystemShares, provisioning: GuestProvisioning?,
        restoreFrom: URL?, onGatewayConnection: @escaping @Sendable (Int32) -> Void, onStop: @escaping @Sendable (String?) -> Void
    ) async throws
    /// `requestStop`, then a forced stop when `force`. Returns whether it stopped gracefully.
    func stop(_ name: String, force: Bool) async throws -> Bool
    func pause(_ name: String) async throws
    func resume(_ name: String) async throws
    /// Pauses, writes the machine state to `url` and stops (warm start next time).
    func saveState(_ name: String, to url: URL) async throws
    /// Replaces the live share sets (no reboot).
    func setShares(_ name: String, shares: [ShareGrant], system: VMSystemShares) async throws
    /// Shows or hides the guest display window (L4 "Take control").
    func setDisplay(_ name: String, visible: Bool) async throws
    /// Connects to the guest helper's vsock control port; the caller owns the descriptor.
    func connectGuestAgent(_ name: String) async throws -> Int32
    func isRunning(_ name: String) -> Bool
    func isPaused(_ name: String) -> Bool
    func isDisplayVisible(_ name: String) -> Bool
    var activeCount: Int { get }
    /// Set when this Mac cannot run guests at all (Intel); every `vm.*` call answers it.
    var unavailableReason: CapabilityError? { get }
}

extension VMBackend {
    public var unavailableReason: CapabilityError? { nil }
}

/// SSH into the guest for the one-time Psyche install (L3; spike 06 step 7). The NAT address is
/// used only here; the control path is vsock.
public protocol GuestShell: Sendable {
    func address(mac: String) -> String?
    /// Creates the helper's per-guest key if needed and returns its public key line.
    func ensureKey(in dir: URL) throws -> String
    /// Runs `command` (a fixed string built by the helper) as `user`; with `password`, uses
    /// password authentication (first contact), otherwise the key.
    func run(host: String, user: String, keyDir: URL, password: String?, command: String, timeout: TimeInterval) async throws -> (status: Int32, output: String)
}

/// Offline TCC pre-grant (L3): mount the stopped guest's Data volume and write the rows.
public protocol GuestPermissionWriter: Sendable {
    /// The guest helper's designated requirement, compiled (`csreq -b`), from the payload's app.
    func designatedRequirement(app: URL) throws -> Data
    func grant(_ bundle: VMBundle, config: VMConfig, client: GuestTCC.Client) async throws
}
