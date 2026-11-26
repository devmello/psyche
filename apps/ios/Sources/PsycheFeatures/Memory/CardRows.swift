import PsycheDesign
import SwiftUI

/// Where a row sits in a paper card, so rows of a `List` can be drawn as one card with swipe actions.
enum CardPosition {
    case only, first, middle, last

    init(index: Int, count: Int) {
        if count <= 1 { self = .only } else if index == 0 { self = .first } else if index == count - 1 { self = .last } else { self = .middle }
    }

    var isFirst: Bool { self == .only || self == .first }
    var isLast: Bool { self == .only || self == .last }
}

/// One horizontal slice of a paper card: sheet fill, a hairline on the outer edges only.
private struct CardSlice: View {
    let position: CardPosition

    var body: some View {
        let radius = PsycheMetrics.cardRadius
        UnevenRoundedRectangle(
            topLeadingRadius: position.isFirst ? radius : 0,
            bottomLeadingRadius: position.isLast ? radius : 0,
            bottomTrailingRadius: position.isLast ? radius : 0,
            topTrailingRadius: position.isFirst ? radius : 0,
            style: .continuous
        )
        .fill(PsycheColor.sheet)
        .overlay(CardEdges(first: position.isFirst, last: position.isLast, radius: radius).stroke(PsycheColor.hairline, lineWidth: 1))
    }
}

/// The open outline of a card slice: both sides always, the top only on the first row, the bottom only on the last.
private struct CardEdges: Shape {
    let first: Bool
    let last: Bool
    let radius: CGFloat

    func path(in bounds: CGRect) -> Path {
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let r = radius
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: last ? rect.maxY - r : rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: first ? rect.minY + r : rect.minY))
        if first {
            p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.minX + r, y: rect.minY), radius: r)
            p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
            p.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY + r), radius: r)
        } else {
            p.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        }
        p.addLine(to: CGPoint(x: rect.maxX, y: last ? rect.maxY - r : rect.maxY))
        if last {
            p.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX - r, y: rect.maxY), radius: r)
            p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
            p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY - r), radius: r)
        }
        return p
    }
}

extension View {
    /// Draws this row as a slice of a paper card inside a plain `List` (so `.swipeActions` work).
    /// `highlighted` washes the row in ink for a moment.
    func cardRow(_ position: CardPosition, highlighted: Bool = false) -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .background {
                CardSlice(position: position)
                    .overlay {
                        if highlighted { PsycheColor.inkText.opacity(0.10) }
                    }
                    .psycheFade(PsycheMotion.Duration.medium, value: highlighted)
            }
            .overlay(alignment: .bottom) {
                if !position.isLast { HairlineDivider().padding(.leading, 14) }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: PsycheMetrics.pagePadding, bottom: 0, trailing: PsycheMetrics.pagePadding))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }

    /// A free-standing row in a `List` that has no card: headers, pickers, spacing.
    func plainRow(top: CGFloat = 0, bottom: CGFloat = 0) -> some View {
        listRowInsets(EdgeInsets(top: top, leading: PsycheMetrics.pagePadding, bottom: bottom, trailing: PsycheMetrics.pagePadding))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}

/// The standard List chrome for Memory's screens: paper, no separators, no system insets.
extension View {
    @MainActor
    func memoryListStyle() -> some View {
        listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 1)
            .psycheScreen()
    }
}

/// The quiet note under pages that are read-mostly on the phone.
struct EditOnMacNote: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "desktopcomputer").font(.footnote).accessibilityHidden(true)
            Text(text).font(.footnote)
        }
        .foregroundStyle(PsycheColor.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A paper card holding stacked rows. (`PaperCard` styles each child separately when handed a bare
/// `ForEach`, so rows go in one stack first.)
struct PaperStack<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        PaperCard {
            VStack(alignment: .leading, spacing: 0) { content }
        }
    }
}

/// Wording for the small gray lines under Memory rows. Times the Gateway wrote ("18:40", "6:40 pm") are shown the
/// way the phone is set (12 or 24 hour), and evidence sources get a sentence ("From your calendar, confirmed").
enum MemoryText {
    /// Rewrites every clock time in `text` with the system time formatter for `locale`. Text without a clock time,
    /// and numbers that are not a valid time ("99:99"), come back unchanged.
    static func localizingTimes(_ text: String, locale: Locale = .autoupdatingCurrent, calendar: Calendar = .autoupdatingCurrent) -> String {
        guard text.contains(":"),
            let regex = try? NSRegularExpression(pattern: #"(?<![\d:])(\d{1,2}):(\d{2})(?!\d)(?:\s?([AaPp])\.?[Mm]\.?)?"#)
        else { return text }
        let ns = text as NSString
        var out = text
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            guard var hour = Int(ns.substring(with: match.range(at: 1))), let minute = Int(ns.substring(with: match.range(at: 2))), minute < 60 else { continue }
            if match.range(at: 3).location != NSNotFound {
                guard (1...12).contains(hour) else { continue }
                let pm = ns.substring(with: match.range(at: 3)).lowercased() == "p"
                hour = hour % 12 + (pm ? 12 : 0)
            }
            guard hour < 24, let date = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: Date(timeIntervalSinceReferenceDate: 0)) else { continue }
            let formatted = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar))
            guard let range = Range(match.range, in: out) else { continue }
            out.replaceSubrange(range, with: formatted)
        }
        return out
    }

    /// "calendar" becomes "From your calendar"; "mail Nov 2" becomes "From your mail, Nov 2"; a trailing
    /// "confirmed" stays as a clause. File names and anything unrecognised pass through untouched.
    static func evidence(_ parts: [String], confirmed: Bool = false) -> String {
        var pieces = parts.map { localizingTimes($0) }
        if let first = parts.first {
            let words = first.split(separator: " ", maxSplits: 1).map(String.init)
            if let word = words.first, let sentence = sourceSentence(word.lowercased()) {
                pieces[0] = words.count > 1 ? "\(sentence), \(localizingTimes(words[1]))" : sentence
            }
        }
        if confirmed { pieces.append(String(localized: "confirmed", bundle: .module)) }
        return pieces.joined(separator: ", ")
    }

    private static func sourceSentence(_ source: String) -> String? {
        switch source {
        case "calendar": String(localized: "From your calendar", bundle: .module)
        case "mail": String(localized: "From your mail", bundle: .module)
        case "messages": String(localized: "From your messages", bundle: .module)
        case "chat": String(localized: "From a chat", bundle: .module)
        case "memory": String(localized: "From memory", bundle: .module)
        default: nil
        }
    }
}
