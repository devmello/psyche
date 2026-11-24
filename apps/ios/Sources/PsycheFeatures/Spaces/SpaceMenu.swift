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

/// The Space page's "More" menu: Archive (after a confirmation that names what pauses) or Restore on an archived
/// Space. Archiving is the owner's tap; nothing is archived on the agent's behalf.
struct SpaceActionsMenu: View {
    let archived: Bool
    let setArchived: (Bool) async -> Bool
    @State private var confirming = false
    @State private var working = false

    var body: some View {
        Menu {
            if archived {
                Button { change(to: false) } label: {
                    Label(String(localized: "Restore", bundle: .module), systemImage: "arrow.uturn.backward")
                }
            } else {
                Button(role: .destructive) { confirming = true } label: {
                    Label(String(localized: "Archive", bundle: .module), systemImage: "archivebox")
                }
            }
        } label: {
            Label(String(localized: "More about this Space", bundle: .module), systemImage: "ellipsis.circle")
        }
        .disabled(working)
        .confirmationDialog(
            String(localized: "Archive this Space?", bundle: .module), isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button(String(localized: "Archive", bundle: .module), role: .destructive) { change(to: true) }
            Button(String(localized: "Cancel", bundle: .module), role: .cancel) {}
        } message: {
            Text("Its automations pause and its folders stop working. You can restore it any time.", bundle: .module)
        }
    }

    private func change(to archive: Bool) {
        working = true
        Task {
            _ = await setArchived(archive)
            working = false
        }
    }
}
