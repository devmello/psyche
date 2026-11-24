import Foundation
import Testing

@testable import PsycheStore

/// The edit sheet's rules: what counts as a change, when Save is allowed, and how aliases are cleaned.
/// Pure model tests: no view, no Gateway.
struct EntityEditDraftTests {
    let due = Date(timeIntervalSince1970: 1_800_000_000)

    func person(aliases: [String] = ["Ada"]) -> EntityCard {
        EntityCard(name: "Ada Lovelace", aliases: aliases, etag: "etag-1")
    }

    func project(status: ProjectStatus? = .active, dueAt: Date? = nil) -> EntityCard {
        EntityCard(name: "Launch", aliases: [], projectStatus: status, dueAt: dueAt, etag: "etag-2")
    }

    @Test func anUntouchedCardHasNoChangesAndCannotSave() {
        let draft = EntityEditDraft(card: person())
        #expect(draft.changes == nil)
        #expect(!draft.canSave)
    }

    @Test func aRenameIsTrimmedAndSendsOnlyTheName() {
        var draft = EntityEditDraft(card: person())
        draft.name = "  Ada King  "
        #expect(draft.changes == EntityChanges(name: "Ada King"))
        #expect(draft.canSave)
    }

    @Test func aBlankOrOverlongNameBlocksSave() {
        var draft = EntityEditDraft(card: person())
        draft.name = "   "
        draft.aliases = ["Countess"]
        #expect(!draft.nameIsValid)
        #expect(!draft.canSave)  // a change is there, but the name is empty

        draft.name = String(repeating: "x", count: EntityEditDraft.maxLength + 1)
        #expect(!draft.nameIsValid)
        #expect(!draft.canSave)

        draft.name = String(repeating: "x", count: EntityEditDraft.maxLength)
        #expect(draft.nameIsValid)
    }

    @Test func addingAnAliasTrimsIt() {
        var draft = EntityEditDraft(card: person())
        let added = draft.addAlias("  Countess  ")
        #expect(added)
        #expect(draft.aliases == ["Ada", "Countess"])
        #expect(draft.changes == EntityChanges(aliases: ["Ada", "Countess"]))
    }

    @Test func aBlankAliasIsRefused() {
        var draft = EntityEditDraft(card: person())
        let added = draft.addAlias("   ")
        #expect(!added)
        #expect(draft.aliases == ["Ada"])
        #expect(draft.changes == nil)
    }

    @Test func aDuplicateAliasIsRefusedIgnoringCase() {
        var draft = EntityEditDraft(card: person())
        let added = draft.addAlias("ada")
        #expect(!added)
        #expect(draft.aliases == ["Ada"])
    }

    @Test func aliasListStopsAtTheSchemaLimit() {
        var draft = EntityEditDraft(card: person(aliases: []))
        for index in 0..<EntityEditDraft.maxAliases {
            let added = draft.addAlias("alias \(index)")
            #expect(added)
        }
        #expect(!draft.canAddAlias)
        let refused = draft.addAlias("one too many")
        #expect(!refused)
        #expect(draft.aliases.count == EntityEditDraft.maxAliases)
    }

    @Test func anAliasOverTheLengthLimitIsRefused() {
        var draft = EntityEditDraft(card: person(aliases: []))
        let tooLong = draft.addAlias(String(repeating: "a", count: EntityEditDraft.maxLength + 1))
        #expect(!tooLong)
        let atLimit = draft.addAlias(String(repeating: "a", count: EntityEditDraft.maxLength))
        #expect(atLimit)
    }

    @Test func removingAnAliasSendsTheWholeNewList() {
        var draft = EntityEditDraft(card: person(aliases: ["Ada", "Countess"]))
        draft.removeAlias(at: 0)
        #expect(draft.changes == EntityChanges(aliases: ["Countess"]))
    }

    @Test func aRemovalOutOfRangeDoesNothing() {
        var draft = EntityEditDraft(card: person())
        draft.removeAlias(at: 5)
        #expect(draft.aliases == ["Ada"])
        #expect(draft.changes == nil)
    }

    @Test func addingThenRemovingTheSameAliasIsNoChange() {
        var draft = EntityEditDraft(card: person(aliases: []))
        let added = draft.addAlias("Countess")
        #expect(added)
        draft.removeAlias(at: 0)
        #expect(draft.changes == nil)
    }

    @Test func aliasesAreCleanedOfBlanksAndDuplicatesKeepingTheFirstSpelling() {
        var draft = EntityEditDraft(card: person(aliases: []))
        draft.aliases = ["  Ada ", "", "ada", "Countess"]
        #expect(draft.cleanAliases == ["Ada", "Countess"])
    }

    @Test func aPersonCardNeverCarriesAProjectChange() {
        var draft = EntityEditDraft(card: person())
        draft.name = "Ada King"
        #expect(draft.changes?.projectStatus == nil)
        #expect(draft.changes?.dueAt == nil)
    }

    @Test func statusChangesOnlyWhenPickedAndDiffers() {
        var draft = EntityEditDraft(card: project(status: .active))
        #expect(draft.changes == nil)
        draft.projectStatus = .active
        #expect(draft.changes == nil)
        draft.projectStatus = .done
        #expect(draft.changes == EntityChanges(projectStatus: .done))
    }

    @Test func aMissingStatusFromTheGatewayIsNotInventedOnSave() {
        var draft = EntityEditDraft(card: project(status: nil))
        draft.name = "Launch 2"
        #expect(draft.changes == EntityChanges(name: "Launch 2"))
    }

    @Test func settingADueDateSendsTheDate() {
        var draft = EntityEditDraft(card: project(dueAt: nil))
        draft.dueAt = due
        #expect(draft.changes == EntityChanges(dueAt: .set(due)))
    }

    @Test func clearingADueDateSendsClear() {
        var draft = EntityEditDraft(card: project(dueAt: due))
        draft.dueAt = nil
        #expect(draft.changes == EntityChanges(dueAt: .clear))
    }

    @Test func anUnchangedDueDateIsNoChange() {
        let draft = EntityEditDraft(card: project(dueAt: due))
        #expect(draft.changes == nil)
    }

    @Test func aDueDateAloneLetsSaveThroughWithAValidName() {
        var draft = EntityEditDraft(card: project(dueAt: due))
        draft.dueAt = nil
        #expect(draft.canSave)
    }

    @Test func editsCombineIntoOneChangeSet() {
        var draft = EntityEditDraft(card: project(status: .active, dueAt: due))
        draft.name = "Launch v2"
        draft.projectStatus = .paused
        draft.dueAt = nil
        #expect(draft.changes == EntityChanges(name: "Launch v2", projectStatus: .paused, dueAt: .clear))
    }

    @Test func theEtagIsKeptFromTheCardItStartedFrom() {
        let draft = EntityEditDraft(card: project())
        #expect(draft.original.etag == "etag-2")
    }
}
