import Foundation
import PsycheProtocol
import Testing

@Suite("wire frames")
struct FramesTests {
    @Test func reqRoundTrips() throws {
        let frame = WireFrame.req(WireReqFrame(id: "1", method: "settings.get", params: .object(["k": .string("v")])))
        let data = try frame.encode()
        #expect(String(decoding: data, as: UTF8.self) == #"{"id":"1","method":"settings.get","params":{"k":"v"},"type":"req"}"#)
        #expect(try WireFrame.decode(data) == frame)
    }

    @Test func decodesErrorResponsesAndEvents() throws {
        let res = try WireFrame.decode(Data(#"{"type":"res","id":"9","ok":false,"error":{"code":"not_paired","message":"m"}}"#.utf8))
        guard case .res(let r) = res else { Issue.record("not a res"); return }
        #expect(!r.ok && r.error?.code == "not_paired")
        let ev = try WireFrame.decode(Data(#"{"type":"event","event":"tick","payload":null,"seq":3,"stateVersion":7}"#.utf8))
        #expect(ev == .event(WireEventFrame(event: "tick", payload: .null, seq: 3, stateVersion: 7)))
        #expect(throws: WireFrame.DecodeError.unknownType("nope")) { try WireFrame.decode(Data(#"{"type":"nope"}"#.utf8)) }
    }
}
