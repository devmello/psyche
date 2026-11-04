import PsycheBlocks
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
            #if DEBUG
            if WidgetGallery.isRequested {
                // Hidden: `-psycheWidgetGallery YES` shows every widget fixture instead of the app.
                WidgetGallery()
            } else {
                RootView().environment(session)
            }
            #else
            RootView()
                .environment(session)
            #endif
        }
    }
}
