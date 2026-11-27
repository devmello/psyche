import Foundation
import PsycheStore

/// The words and figures of Fork a plan, in the app's language. Figures are shown exactly as the report holds them (the
/// model never writes a number, §4.3); only the formatting is the phone's. Strings are the model's and may echo another
/// person's words, so every view draws them with `Text(verbatim:)`.
enum PlanForkText {
    /// "$2,190.00". An unknown currency code falls back to the code and the plain number, never a guessed symbol.
    static func money(_ amount: Double, currency: String) -> String {
        guard currency.count == 3, currency.allSatisfy({ $0.isASCII && $0.isLetter }) else {
            return amount.formatted(.number.precision(.fractionLength(0...2)))
        }
        return amount.formatted(.currency(code: currency).precision(.fractionLength(amount == amount.rounded() ? 0 : 2)))
    }

    static func cost(_ cost: PlanForkCost) -> String {
        let figure = money(cost.amount, currency: cost.currency)
        switch cost.period {
        case .once: return figure
        case .month: return String(localized: "\(figure) per month", bundle: .module)
        case .year: return String(localized: "\(figure) per year", bundle: .module)
        }
    }

    /// One computed total: "$2,190 per month", with ", includes estimates" when any part is Psyche's estimate.
    static func total(_ total: PlanForkTotal) -> String {
        let line = cost(PlanForkCost(id: "", label: "", amount: total.amount, currency: total.currency, period: total.period))
        return total.includesEstimate ? String(localized: "\(line), includes estimates", bundle: .module) : line
    }

    /// `2030-03-01` or an ISO date-time as a short date. Anything that does not parse is shown as it came.
    static func date(_ iso: String, in zone: TimeZone = .current) -> String {
        // A day with no time is a calendar day, not a moment: it is read and shown in UTC so it never slips a day.
        let day = dayOnly.date(from: String(iso.prefix(10)))
        if let day, iso.count <= 10 { return day.formatted(Self.dayStyle) }
        if let moment = WireDates.date(iso) {
            return moment.formatted(Date.FormatStyle(timeZone: zone).month(.abbreviated).day().year().hour().minute())
        }
        if let day { return day.formatted(Self.dayStyle) }
        return iso
    }

    private static var dayStyle: Date.FormatStyle {
        Date.FormatStyle(timeZone: TimeZone(identifier: "UTC") ?? .gmt).month(.abbreviated).day().year()
    }

    private static let dayOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    static func dimension(_ dimension: PlanComparisonDimension) -> String {
        switch dimension {
        case .cost: String(localized: "Costs", bundle: .module)
        case .dates: String(localized: "Dates", bundle: .module)
        case .people: String(localized: "People", bundle: .module)
        case .tradeoffs: String(localized: "Trade-offs", bundle: .module)
        case .risks: String(localized: "Risks", bundle: .module)
        case .open: String(localized: "Open questions", bundle: .module)
        }
    }

    static func source(_ source: PlanForkSource) -> String {
        switch source {
        case .memory: String(localized: "Memory", bundle: .module)
        case .mail: String(localized: "Mail", bundle: .module)
        case .calendar: String(localized: "Calendar", bundle: .module)
        case .contacts: String(localized: "Contacts", bundle: .module)
        case .messages: String(localized: "Messages", bundle: .module)
        case .web: String(localized: "Web", bundle: .module)
        case .files: String(localized: "Files", bundle: .module)
        }
    }

    static func likelihood(_ likelihood: PlanForkRisk.Likelihood) -> String {
        switch likelihood {
        case .low: String(localized: "Low chance", bundle: .module)
        case .medium: String(localized: "Medium chance", bundle: .module)
        case .high: String(localized: "High chance", bundle: .module)
        }
    }

    static func status(_ status: PlanForkStatus) -> String {
        switch status {
        case .running: String(localized: "Working on it", bundle: .module)
        case .comparing: String(localized: "Comparing", bundle: .module)
        case .ready: String(localized: "Ready", bundle: .module)
        case .taken: String(localized: "Plan taken", bundle: .module)
        case .dismissed: String(localized: "Dismissed", bundle: .module)
        case .expired: String(localized: "Expired", bundle: .module)
        case .cancelled: String(localized: "Cancelled", bundle: .module)
        case .failed: String(localized: "Couldn't finish", bundle: .module)
        }
    }

    static func branchStatus(_ status: PlanForkBranchStatus) -> String {
        switch status {
        case .queued: String(localized: "Waiting for a slot", bundle: .module)
        case .running: String(localized: "Working on it", bundle: .module)
        case .reported: String(localized: "Done", bundle: .module)
        case .failed: String(localized: "Couldn't finish", bundle: .module)
        case .cancelled: String(localized: "Cancelled", bundle: .module)
        case .budgetStopped: String(localized: "Stopped at its spending limit", bundle: .module)
        }
    }

    /// "1 more on your Mac": items the Gateway withheld because they cite Memory, Messages or Contacts.
    static func moreOnMac(_ count: Int) -> String {
        String(localized: "\(count) more on your Mac", bundle: .module)
    }

    static var totalOnMac: String { String(localized: "Total on your Mac", bundle: .module) }
    static var readOnMac: String { String(localized: "Open on your Mac to read this", bundle: .module) }

    /// "Move to Austin vs Stay".
    static func title(_ labels: [String]) -> String {
        labels.joined(separator: " \(String(localized: "vs", bundle: .module)) ")
    }

    /// "Up to about $0.40", or "Up to about 300,000 tokens" for a model with no price.
    static func estimate(_ estimate: PlanForkEstimate) -> String {
        if let usd = estimate.maxUsd {
            let figure = usd.formatted(.currency(code: "USD").precision(.fractionLength(usd < 10 ? 2 : 0)))
            return String(localized: "Up to about \(figure)", bundle: .module)
        }
        let tokens = estimate.maxTokens.formatted()
        return String(localized: "Up to about \(tokens) tokens", bundle: .module)
    }
}

/// The wire's ISO date-times, parsed once.
enum WireDates {
    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func date(_ text: String) -> Date? { plain.date(from: text) ?? fractional.date(from: text) }
}
