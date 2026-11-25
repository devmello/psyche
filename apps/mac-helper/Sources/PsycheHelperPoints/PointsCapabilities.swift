import Foundation
import PsycheAXEnable
import PsycheAXRead
import PsycheCapture
import PsycheHelperCore

/// Psyche points (docs/design/psyche-points-2026.md): the helper half. W2 is only the target
/// boundary: this target may import `PsycheHelperCore`, `PsycheAXRead`, `PsycheCapture` and
/// `PsycheAXEnable`, never `PsycheHelperSystem`, so nothing here can post an event or perform an
/// AX action. `scripts/check-points-boundary.sh` enforces it. The `points.*` handlers arrive in W3.
public enum PointsCapabilities {
    public static func make() -> [any CapabilityHandler] { [] }
}
