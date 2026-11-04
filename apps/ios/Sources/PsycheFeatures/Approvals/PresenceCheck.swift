import LocalAuthentication
import SwiftUI

/// Proof that the owner is holding the phone, asked before a payment-grade approval is allowed
/// (docs/design/ios-app-2026.md §4.3). Face ID, falling back to the device passcode.
enum PresenceResult: Equatable {
    case confirmed
    /// The owner dismissed the prompt: nothing to report.
    case cancelled
    /// The phone can't check (no passcode set): the answer waits for the Mac.
    case unavailable(String)
}

protocol PresenceCheck: Sendable {
    func confirm(reason: String) async -> PresenceResult
}

struct DevicePresenceCheck: PresenceCheck {
    func confirm(reason: String) async -> PresenceResult {
        let context = LAContext()
        context.localizedFallbackTitle = "Use passcode"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            #if targetEnvironment(simulator)
            return .confirmed  // The simulator has no passcode or enrolled face by default.
            #else
            return .unavailable("Set a passcode on this phone to allow this here, or answer on your Mac.")
            #endif
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            return ok ? .confirmed : .cancelled
        } catch let error as LAError where error.code == .userCancel || error.code == .systemCancel || error.code == .appCancel {
            return .cancelled
        } catch {
            return .unavailable(error.localizedDescription)
        }
    }
}

extension EnvironmentValues {
    @Entry var presenceCheck: any PresenceCheck = DevicePresenceCheck()
}
