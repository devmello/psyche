import PsycheStore
import SwiftUI

extension EnvironmentValues {
    /// The snapshot store the screens read. Fixtures until I2 provides the cache.
    @Entry var snapshotStore: any SnapshotStore = FixtureSnapshotStore()
}
