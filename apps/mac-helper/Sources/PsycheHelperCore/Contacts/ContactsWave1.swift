import Foundation
import PsycheProtocol

// Contacts wave 1 (docs/connectors/apple-apps-2026.md §4.5, P1–P3): pure pieces. The live
// backend is CNContactStore in PsycheHelperSystem. The `note` field is never read (it needs an
// Apple-granted entitlement).

public struct LabeledValueRecord: Codable, Sendable, Equatable {
    public var label: String
    public var value: String
    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public struct ContactAddressRecord: Codable, Sendable, Equatable {
    public var label: String
    public var street: String
    public var city: String
    public var state: String
    public var postalCode: String
    public var country: String
    public init(label: String, street: String, city: String, state: String, postalCode: String, country: String) {
        self.label = label
        self.street = street
        self.city = city
        self.state = state
        self.postalCode = postalCode
        self.country = country
    }
}

/// `AppleContactSummary`.
public struct ContactSummaryRecord: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var organization: String
    public var emails: [String]
    public var phones: [String]
    public init(id: String, name: String, organization: String, emails: [String], phones: [String]) {
        self.id = id
        self.name = name
        self.organization = organization
        self.emails = emails
        self.phones = phones
    }
}

/// `AppleContact` (no `note`).
public struct ContactRecord: Codable, Sendable, Equatable {
    public var id: String
    public var givenName: String
    public var familyName: String
    public var nickname: String
    public var organization: String
    public var jobTitle: String
    public var emails: [LabeledValueRecord]
    public var phones: [LabeledValueRecord]
    public var addresses: [ContactAddressRecord]
    public var urls: [LabeledValueRecord]
    public var birthday: String?
    public var groups: [String]

    public init(id: String, givenName: String = "", familyName: String = "", nickname: String = "", organization: String = "", jobTitle: String = "",
                emails: [LabeledValueRecord] = [], phones: [LabeledValueRecord] = [], addresses: [ContactAddressRecord] = [],
                urls: [LabeledValueRecord] = [], birthday: String? = nil, groups: [String] = []) {
        self.id = id
        self.givenName = givenName
        self.familyName = familyName
        self.nickname = nickname
        self.organization = organization
        self.jobTitle = jobTitle
        self.emails = emails
        self.phones = phones
        self.addresses = addresses
        self.urls = urls
        self.birthday = birthday
        self.groups = groups
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(givenName, forKey: .givenName)
        try c.encode(familyName, forKey: .familyName)
        try c.encode(nickname, forKey: .nickname)
        try c.encode(organization, forKey: .organization)
        try c.encode(jobTitle, forKey: .jobTitle)
        try c.encode(emails, forKey: .emails)
        try c.encode(phones, forKey: .phones)
        try c.encode(addresses, forKey: .addresses)
        try c.encode(urls, forKey: .urls)
        try c.encode(birthday, forKey: .birthday)
        try c.encode(groups, forKey: .groups)
    }
}

/// `contacts.create` / `contacts.update` inputs (`AppleContactInput` / `AppleContactUpdate`).
public struct ContactInputRecord: Decodable, Sendable, Equatable {
    public var givenName: String?
    public var familyName: String?
    public var organization: String?
    public var jobTitle: String?
    public var birthday: String?
    public var emails: [LabeledValueRecord]?
    public var phones: [LabeledValueRecord]?
}

public struct ContactUpdateRecord: Decodable, Sendable, Equatable {
    public var id: String
    public var givenName: String?
    public var familyName: String?
    public var organization: String?
    public var jobTitle: String?
    public var birthday: String?
    public var addEmails: [LabeledValueRecord]?
    public var addPhones: [LabeledValueRecord]?
}

public enum ContactsWave1 {
    /// `_$!<Home>!$_` → `home`; custom labels kept as typed.
    public static func label(fromStore raw: String?) -> String {
        guard var s = raw, !s.isEmpty else { return "" }
        if s.hasPrefix("_$!<"), s.hasSuffix(">!$_") { s = String(s.dropFirst(4).dropLast(4)) }
        return s.lowercased() == "iphone" ? "iphone" : s.lowercased()
    }

    /// `home` → `_$!<Home>!$_` (the store's constants); other text stays a custom label.
    public static let storeLabels: [String: String] = [
        "home": "_$!<Home>!$_", "work": "_$!<Work>!$_", "other": "_$!<Other>!$_", "mobile": "_$!<Mobile>!$_",
        "main": "_$!<Main>!$_", "homefax": "_$!<HomeFAX>!$_", "workfax": "_$!<WorkFAX>!$_", "pager": "_$!<Pager>!$_",
        "iphone": "iPhone", "school": "_$!<School>!$_", "homepage": "_$!<HomePage>!$_",
    ]

    public static func storeLabel(_ label: String) -> String? {
        let l = label.trimmingCharacters(in: .whitespaces)
        if l.isEmpty { return nil }
        return storeLabels[l.lowercased()] ?? l
    }

    /// `YYYY-MM-DD` or `--MM-DD` → (year?, month, day).
    public static func birthday(_ s: String) throws -> (year: Int?, month: Int, day: Int) {
        let p = s.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        // "--MM-DD" splits as ["", "", "MM", "DD"].
        let (y, m, d): (String?, String, String) = p.count == 4 && p[0].isEmpty && p[1].isEmpty ? (nil, p[2], p[3])
            : p.count == 3 && p[0].count == 4 ? (p[0], p[1], p[2]) : ("x", "x", "x")
        guard let month = Int(m), let day = Int(d), (1...12).contains(month), (1...31).contains(day), m.count == 2, d.count == 2,
              y == nil || (Int(y!).map { (1...9999).contains($0) } ?? false)
        else { throw CapabilityError.invalidParams("birthday is YYYY-MM-DD or --MM-DD", field: "birthday") }
        return (y.flatMap { Int($0) }, month, day)
    }

    public static func birthdayString(year: Int?, month: Int, day: Int) -> String {
        year.map { String(format: "%04d-%02d-%02d", $0, month, day) } ?? String(format: "--%02d-%02d", month, day)
    }

    public static func checkEmail(_ v: String, field: String) throws {
        guard v.count <= 320, v.contains("@"), !v.contains(where: { $0.isWhitespace || $0 == "," || $0 == ";" }) else {
            throw CapabilityError.invalidParams("each email is one address", field: field)
        }
    }

    public static func checkPhone(_ v: String, field: String) throws {
        guard (3...40).contains(v.count), v.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "+0123456789 ()-./ext").contains($0) }) else {
            throw CapabilityError.invalidParams("each phone is a phone number", field: field)
        }
    }

    static func digits(_ s: String) -> String { String(s.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) }.map(Character.init)) }

    /// 0 = no match; higher is better: exact name or email 100, name prefix 80, word prefix 60,
    /// phone digits 70, contains 40, organization 30.
    public static func score(_ c: ContactSummaryRecord, query: String) -> Int {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return 0 }
        let name = c.name.lowercased()
        var best = 0
        if name == q { best = 100 } else if name.hasPrefix(q) { best = 80 }
        else if name.split(separator: " ").contains(where: { $0.hasPrefix(q) }) { best = 60 } else if name.contains(q) { best = 40 }
        for e in c.emails.map({ $0.lowercased() }) {
            if e == q { best = max(best, 100) } else if e.hasPrefix(q) { best = max(best, 75) } else if e.contains(q) { best = max(best, 40) }
        }
        let qd = digits(q)
        if qd.count >= 4, c.phones.contains(where: { digits($0).hasSuffix(qd) || digits($0).contains(qd) }) { best = max(best, 70) }
        if c.organization.lowercased().contains(q) { best = max(best, 30) }
        return best
    }

    /// Best match first, then by name.
    public static func search(_ all: [ContactSummaryRecord], query: String, limit: Int) -> [ContactSummaryRecord] {
        let scored: [(ContactSummaryRecord, Int)] = all.map { ($0, score($0, query: query)) }.filter { $0.1 > 0 }
        let sorted = scored.sorted { (a: (ContactSummaryRecord, Int), b: (ContactSummaryRecord, Int)) -> Bool in
            a.1 == b.1 ? a.0.name < b.0.name : a.1 > b.1
        }
        return sorted.prefix(max(0, limit)).map { $0.0 }
    }
}
