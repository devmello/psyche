import Foundation
import PsycheProtocol

/// `contacts.list` (issue #121, S17 dictation vocabulary): names only, so a speech recognizer can
/// learn them. Phone numbers, emails and addresses are never read or returned.
public enum ContactsList {
    public static let defaultLimit = 500
    public static let maxLimit = 2000
    public static let maxQuery = 80
    public static let supportedFields: Set = ["name"]

    public struct Params: Decodable, Sendable, Equatable {
        public var limit: Int?
        public var fields: [String]?
        public var query: String?
    }

    /// One store record, before filtering (`name` is the formatter's full name, possibly empty).
    public struct Record: Sendable, Equatable {
        public var id: String
        public var name: String
        public var givenName: String
        public var familyName: String
        public var nickname: String
        public var organization: String

        public init(id: String, name: String, givenName: String, familyName: String, nickname: String = "", organization: String = "") {
            self.id = id
            self.name = name
            self.givenName = givenName
            self.familyName = familyName
            self.nickname = nickname
            self.organization = organization
        }
    }

    /// Validates params; returns (limit, query).
    public static func validate(_ p: Params) throws -> (limit: Int, query: String?) {
        let limit = p.limit ?? defaultLimit
        guard (1...maxLimit).contains(limit) else {
            throw CapabilityError.invalidParams("limit must be 1–\(maxLimit)", field: "limit")
        }
        if let fields = p.fields {
            guard !fields.isEmpty, fields.allSatisfy(supportedFields.contains) else {
                throw CapabilityError.invalidParams("fields supports only \"name\"", field: "fields")
            }
        }
        var query = p.query?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let q = query {
            guard q.count <= maxQuery else { throw CapabilityError.invalidParams("query is at most \(maxQuery) characters", field: "query") }
            if q.isEmpty { query = nil }
        }
        return (limit, query)
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// Skips nameless records, applies the prefix query, orders by family then given name (stable
    /// across calls), and cuts to `limit`.
    public static func result(records: [Record], limit: Int, query: String?) -> JSONValue {
        let q = query.map(fold)
        var named = records.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
        if let q {
            named = named.filter { fold($0.givenName).hasPrefix(q) || fold($0.familyName).hasPrefix(q) }
        }
        named.sort { a, b in
            let fa = fold(a.familyName), fb = fold(b.familyName)
            if fa != fb { return fa < fb }
            let ga = fold(a.givenName), gb = fold(b.givenName)
            if ga != gb { return ga < gb }
            return a.id < b.id
        }
        let kept = named.prefix(limit)
        let contacts: [JSONValue] = kept.map { r in
            var o: [String: JSONValue] = ["id": .string(r.id), "name": .string(r.name)]
            let nick = r.nickname.trimmingCharacters(in: .whitespaces)
            let org = r.organization.trimmingCharacters(in: .whitespaces)
            if !nick.isEmpty { o["nickname"] = .string(nick) }
            if !org.isEmpty { o["organization"] = .string(org) }
            return .object(o)
        }
        return ["contacts": .array(contacts), "total": .int(records.count), "truncated": .bool(named.count > limit)]
    }
}
