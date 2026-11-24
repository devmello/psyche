import Foundation
import PsycheStore
import Testing

@testable import PsycheClient

/// The Gateway's `LibraryItemKind` values (`packages/protocol/src/schemas/surfaces.ts`). A new kind must be added here
/// and to the section mapping in the same change.
private let gatewayKinds = ["document", "image", "audio", "video", "artifact", "download", "recording", "system"]

struct LibrarySectionMappingTests {
    @Test func everyGatewayKindLandsInExactlyOneSectionAndThatSectionListsIt() {
        for kind in gatewayKinds {
            let section = GatewayBackend.section(ofKind: kind)
            let listing = LibrarySection.allCases.filter { GatewayBackend.wireKinds(of: $0).contains(kind) }
            #expect(listing == [section], "kind \(kind) is listed by \(listing.map(\.rawValue)), shown in \(section.rawValue)")
        }
    }

    @Test func everyKindASectionListsMapsBackToThatSection() {
        for section in LibrarySection.allCases {
            for kind in GatewayBackend.wireKinds(of: section) {
                #expect(GatewayBackend.section(ofKind: kind) == section, "\(kind) listed in \(section.rawValue)")
            }
        }
    }

    @Test func everyGatewayKindIsListedSomewhere() {
        let listed = Set(LibrarySection.allCases.flatMap { GatewayBackend.wireKinds(of: $0) })
        #expect(listed == Set(gatewayKinds))
    }

    @Test func recordingsCollectVoiceMemosMeetingsAndBrowserRecordings() {
        #expect(GatewayBackend.section(ofKind: "recording") == .recordings)
        #expect(GatewayBackend.section(ofKind: "audio") == .recordings)
        #expect(GatewayBackend.section(ofKind: "video") == .recordings)
        #expect(GatewayBackend.section(ofKind: "system") == .documents)
        #expect(GatewayBackend.section(ofKind: "future-kind") == .documents)
    }

    @Test func mergedRowsAreNewestFirstAndUndatedRowsKeepTheGatewayOrderAtTheEnd() {
        let early = Date(timeIntervalSince1970: 100)
        let late = Date(timeIntervalSince1970: 200)
        func item(_ id: String) -> LibraryItem {
            LibraryItem(id: id, title: id, section: .recordings, fileType: "wav", detail: "")
        }
        let merged = GatewayBackend.newestFirst([
            (early, item("a")),
            (nil, item("x")),
            (late, item("b")),
            (nil, item("y")),
        ])
        #expect(merged.map(\.id) == ["b", "a", "x", "y"])
    }
}
