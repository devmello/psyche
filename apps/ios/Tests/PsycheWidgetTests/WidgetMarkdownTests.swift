import Testing
@testable import PsycheStore

@testable import PsycheBlocks

struct WidgetMarkdownTests {
    @Test func blocksParse() {
        let blocks = WidgetMarkdown.parse("""
            # Title
            Some **bold** text
            continues here.

            - one
            - two
            1. first
            > quoted

            ```
            let x = 1
            ```
            """)
        #expect(blocks == [
            .heading(level: 1, text: "Title"),
            .paragraph("Some **bold** text continues here."),
            .bullet("one"), .bullet("two"), .numbered(1, "first"), .quote("quoted"),
            .code("let x = 1"),
        ])
    }

    @Test func unsafeLinksLoseTheirTarget() {
        let text = WidgetMarkdown.inline("[ok](https://example.com) [bad](javascript:alert(1)) [mail](mailto:a@b.co) [file](file:///etc/passwd)")
        let links = text.runs.compactMap { $0.link?.absoluteString }
        #expect(links == ["https://example.com", "mailto:a@b.co"])
    }

    @Test func rawHTMLStaysText() {
        let text = WidgetMarkdown.inline("<img src=x onerror=alert(1)> hi")
        #expect(String(text.characters).contains("<img"))
        #expect(text.runs.allSatisfy { $0.link == nil })
    }

    @Test func anUnclosedFenceStillShowsItsCode() {
        #expect(WidgetMarkdown.parse("```\nabc") == [.code("abc")])
    }
}

struct WidgetFormValidationTests {
    private func form() -> FormNode {
        guard case .form(_, let form)? = WidgetFixture.interactive.snapshot.root.find(id: "note") else { fatalError("fixture") }
        return form
    }

    @Test func aMissingRequiredFieldGetsAnInlineError() {
        #expect(form().errors(for: [:]) == ["name": "Name is required."])
        #expect(form().errors(for: ["name": .string("Sam")]).isEmpty)
    }

    @Test func aToggleIsNeverRequiredToBeOn() {
        var form = form()
        form.fields[2].required = true
        #expect(form.errors(for: ["name": .string("Sam")]).isEmpty)
    }

    @Test func textInANumberFieldIsRejected() {
        guard case .form(_, let form)? = WidgetFixture.interactive.snapshot.root.find(id: "toolform") else { Issue.record("fixture"); return }
        #expect(form.errors(for: ["to": .string("a@b.co"), "count": .string("lots")]) == ["count": "Enter a number."])
        #expect(form.errors(for: ["to": .string("a@b.co"), "count": .number(2)]).isEmpty)
    }
}
