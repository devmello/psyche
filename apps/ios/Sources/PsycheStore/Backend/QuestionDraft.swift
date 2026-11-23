import Foundation

/// The owner's picks on a multi-part question: the chosen options of each part and the typed "Other" text. Pure,
/// so the sheet and the tests share one rule for when an answer is complete and what it contains.
public struct QuestionDraft: Sendable, Equatable {
    /// Stands for the "Other" row in `selected`. No option id can equal it (it holds a NUL).
    public static let otherID = "\u{0}other"
    /// The most choices one part may send (the Gateway's `maxItems`).
    public static let maxChoices = 4
    /// The longest one answer may be (the Gateway's `maxLength`).
    public static let maxTextLength = 4000

    public let parts: [QuestionDetail.Part]
    /// The chosen option ids (or `otherID`) per part header, in the order they were picked.
    public private(set) var selected: [String: [String]] = [:]
    /// The typed "Other" text per part header.
    public private(set) var typed: [String: String] = [:]

    public init(detail: QuestionDetail) {
        parts = detail.parts
    }

    /// Picks an option. A single-choice part keeps one pick; a multi-select part toggles it.
    public mutating func choose(header: String, optionID: String) {
        guard let part = part(header), part.options.contains(where: { $0.id == optionID }) else { return }
        var picks = selected[header] ?? []
        if part.multiSelect {
            if let index = picks.firstIndex(of: optionID) {
                picks.remove(at: index)
            } else {
                picks.append(optionID)
            }
        } else {
            picks = [optionID]
            typed[header] = nil
        }
        selected[header] = picks
    }

    /// Types the "Other" answer. Typing selects the Other row; emptying it unselects the row again.
    public mutating func type(_ text: String, header: String) {
        guard let part = part(header), part.allowsFreeText else { return }
        typed[header] = text
        var picks = selected[header] ?? []
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            picks.removeAll { $0 == Self.otherID }
        } else if !picks.contains(Self.otherID) {
            if part.multiSelect {
                picks.append(Self.otherID)
            } else {
                picks = [Self.otherID]
            }
        }
        selected[header] = picks
    }

    /// The answer to one part, or nil while it is unanswered or over a limit.
    public func value(for part: QuestionDetail.Part) -> QuestionAnswer.Value? {
        let chosen: [String] = (selected[part.header] ?? []).compactMap { id in
            if id == Self.otherID {
                return typed[part.header]?.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return part.options.first { $0.id == id }?.value
        }.filter { !$0.isEmpty }
        guard !chosen.isEmpty, chosen.allSatisfy({ $0.count <= Self.maxTextLength }) else { return nil }
        if part.multiSelect {
            return chosen.count <= Self.maxChoices ? .choices(chosen) : nil
        }
        return chosen.count == 1 ? .text(chosen[0]) : nil
    }

    /// Headers still waiting for an answer, in request order. Empty when the answer can be sent.
    public var unanswered: [String] {
        parts.filter { value(for: $0) == nil }.map(\.header)
    }

    /// The whole answer, keyed by every part's header, or nil while any part is unanswered.
    public func answer() -> QuestionAnswer? {
        var values: [String: QuestionAnswer.Value] = [:]
        for part in parts {
            guard let value = value(for: part) else { return nil }
            values[part.header] = value
        }
        return QuestionAnswer(values: values)
    }

    private func part(_ header: String) -> QuestionDetail.Part? {
        parts.first { $0.header == header }
    }
}
