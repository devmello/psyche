import PsycheDesign
import PsycheStore
import SwiftUI

/// The Chat tab's Space menu (spaces-2026.md §7.2, SP5): "No Space" and the Spaces. Choosing one makes it the home of
/// the next new chat. The app never guesses: with nothing chosen a new chat is in no Space.
struct SpaceTargetMenu: View {
    let model: SpaceMenuModel

    var body: some View {
        Menu {
            Button { model.choose(nil) } label: { check(String(localized: "No Space", bundle: .module), model.target == nil) }
            ForEach(model.spaces) { space in
                Button { model.choose(space.id) } label: { check(space.name, model.target == space.id) }
            }
        } label: {
            Label(model.targetName ?? String(localized: "Space", bundle: .module), systemImage: "square.stack")
        }
        .accessibilityLabel(String(localized: "Space", bundle: .module))
    }

    @ViewBuilder
    private func check(_ title: String, _ selected: Bool) -> some View {
        if selected { Label(title, systemImage: "checkmark") } else { Text(verbatim: title) }
    }
}

/// "Move to Space" on a chat row: out of any Space, or into one of them.
struct MoveToSpaceMenu: View {
    let model: SpaceMenuModel
    let thread: ChatThreadSummary
    let moved: () async -> Void

    var body: some View {
        Menu {
            if thread.spaceID != nil {
                Button(String(localized: "No Space", bundle: .module)) { move(nil) }
            }
            ForEach(model.spaces.filter { $0.id != thread.spaceID }) { space in
                Button(space.name) { move(space.id) }
            }
        } label: {
            Label(String(localized: "Move to Space", bundle: .module), systemImage: "square.stack")
        }
    }

    private func move(_ spaceID: String?) {
        Task {
            await model.move(thread, to: spaceID)
            await moved()
        }
    }
}
