import CoreGraphics
import Foundation
import PsycheProtocol
import Testing

@testable import PsycheHelperCore

/// What the overlay may ask the engine about the field it points at: frames and a label, never a value.
@Suite("Points overlay: target info")
struct PointsTargetInfoTests {
    private func page() -> (FakePointsSource, [Int]) {
        let src = FakePointsSource()
        src.attrs[0]?.frame = CGRect(x: 100, y: 100, width: 800, height: 600)
        var nodes: [Int] = []
        for (i, title) in ["Full name", "Employer", "City", "Notes"].enumerated() {
            nodes.append(src.add(role: "AXTextField", title: title, value: "v\(i)", frame: CGRect(x: 300, y: 200 + 60 * i, width: 300, height: 30)))
        }
        return (src, nodes)
    }

    @Test func givesFramesLabelAndTheNextTwoFieldsAndReadsNoValue() throws {
        let (src, nodes) = page()
        let engine = PointsEngine(source: src, target: .fake) { _ in }
        engine.begin(at: 0)
        src.resetReads()
        let id = try #require(engine.fieldId(for: nodes[0]))
        let info = try #require(engine.targetInfo(for: id))
        #expect(info.label == "Full name")
        #expect(info.frame == CGRect(x: 300, y: 200, width: 300, height: 30))
        #expect(info.nextFrames == [CGRect(x: 300, y: 260, width: 300, height: 30), CGRect(x: 300, y: 320, width: 300, height: 30)])
        #expect(info.nextIds.count == 2)
        #expect(info.windowFrame == CGRect(x: 100, y: 100, width: 800, height: 600))
        #expect(!info.sensitive)
        #expect(src.valueReads.isEmpty, "targetInfo reads frames only")
        // The last field has no next field; an unknown id has no info.
        let last = try #require(engine.fieldId(for: nodes[3]))
        #expect(engine.targetInfo(for: last)?.nextFrames == [])
        #expect(engine.targetInfo(for: "f999") == nil)
    }

    @Test func aSensitiveFieldIsFlaggedSoNoSuggestionIsOffered() throws {
        let src = FakePointsSource()
        let ssn = src.add(role: "AXTextField", title: "Social Security number", value: "x", frame: CGRect(x: 10, y: 10, width: 100, height: 20))
        let plain = src.add(role: "AXTextField", title: "City", value: "x", frame: CGRect(x: 10, y: 50, width: 100, height: 20))
        let engine = PointsEngine(source: src, target: .fake) { _ in }
        engine.begin(at: 0)
        src.resetReads()
        #expect(try engine.targetInfo(for: #require(engine.fieldId(for: ssn)))?.sensitive == true)
        #expect(try engine.targetInfo(for: #require(engine.fieldId(for: plain)))?.sensitive == false)
        #expect(src.valueReads.isEmpty)
    }

    @Test func framesFollowAScrollOnlyForTheWatchedFields() throws {
        let (src, nodes) = page()
        var seen: [[String: CGRect]] = []
        let engine = PointsEngine(source: src, target: .fake) { _ in }
        engine.onFrames = { seen.append($0) }
        engine.begin(at: 0)
        let a = try #require(engine.fieldId(for: nodes[0]))
        let b = try #require(engine.fieldId(for: nodes[1]))
        engine.setWatched([a, b])
        src.attrs[nodes[0]]?.frame = CGRect(x: 300, y: 150, width: 300, height: 30)
        engine.notify(.geometryChanged, at: 5)
        engine.tick(at: 6)
        let last = try #require(seen.last)
        #expect(Set(last.keys) == [a, b])
        #expect(last[a] == CGRect(x: 300, y: 150, width: 300, height: 30))
    }
}
