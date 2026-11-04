import PsycheClient
import PsycheDesign
import PsycheFeatures
import SwiftUI

@main
struct PsycheApp: App {
    @State private var session = Session(driver: FixtureSessionDriver.fromLaunchArguments())

    init() {
        PsycheAppearance.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
        }
    }
}
