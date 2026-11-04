import PsycheStore
import SwiftUI

extension EnvironmentValues {
    /// The backend the screens read and write: `FixtureBackend` until I2 provides `GatewayBackend`.
    @Entry var backend: any PsycheBackend = FixtureBackend.shared
}
