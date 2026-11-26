import Foundation
import Testing

@testable import PsycheFeatures

@Suite("Memory row wording")
struct MemoryTextTests {
    private let cal = Calendar(identifier: .gregorian)
    private let us = Locale(identifier: "en_US")
    private let gb = Locale(identifier: "en_GB")

    private func normalized(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    @Test("24-hour and 12-hour times both follow the phone's setting")
    func timesFollowLocale() {
        #expect(normalized(MemoryText.localizingTimes("Lands at 6:40 pm", locale: us, calendar: cal)) == "Lands at 6:40 PM")
        #expect(normalized(MemoryText.localizingTimes("Today 18:40", locale: us, calendar: cal)) == "Today 6:40 PM")
        #expect(MemoryText.localizingTimes("Lands at 6:40 pm", locale: gb, calendar: cal) == "Lands at 18:40")
        #expect(MemoryText.localizingTimes("Monday 08:58", locale: gb, calendar: cal) == "Monday 08:58")
    }

    @Test("Text that is not a clock time is left alone")
    func nearMisses() {
        for text in ["Score 99:99", "Ratio 1:1", "ID 12:345", "Nov 2", "No colon here", "13:70", "13:30 pm"] {
            #expect(MemoryText.localizingTimes(text, locale: us, calendar: cal) == text, "\(text)")
        }
    }

    @Test("Sources read as sentences")
    func sources() {
        #expect(MemoryText.evidence(["calendar"], confirmed: true) == "From your calendar, confirmed")
        #expect(MemoryText.evidence(["mail Nov 2"]) == "From your mail, Nov 2")
        #expect(MemoryText.evidence(["lease-2026.pdf"]) == "lease-2026.pdf")
        #expect(MemoryText.evidence([]) == "")
        #expect(MemoryText.evidence([], confirmed: true) == "confirmed")
    }
}
