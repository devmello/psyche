import Foundation

/// What the owner reads when the Gateway holds this phone to its model budget (`rate_limited` with
/// `details.reason == "model_budget"`): a plain sentence with the wait in whole minutes, never the
/// Gateway's English text. One mapping for every screen (`BackendError.slowDown`).
public enum SlowDown {
    public static let reason = "model_budget"

    /// Whole minutes to wait, at least one, from the error's `retryAfterMs` (a minute when it is missing or unusable).
    public static func minutes(retryAfterMs: Double?) -> Int {
        guard let ms = retryAfterMs, ms.isFinite, ms > 0 else { return 1 }
        return max(1, Int((ms / 60_000).rounded(.up)))
    }

    public static func message(minutes: Int) -> String {
        String(localized: "Too many requests from this device. Try again in \(minutes) minutes.", bundle: .module)
    }
}
