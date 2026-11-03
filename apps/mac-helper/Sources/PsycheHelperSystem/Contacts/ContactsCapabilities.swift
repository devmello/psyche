import Contacts
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `contacts.list` (issue #121): names for dictation vocabulary. Read-only; never prompts (the
/// first-use prompt belongs to `permissions.request`), so a missing grant is an error the Gateway
/// treats as "no names".
public enum ContactsCapabilities {
    /// Reads every contact's name fields; nil when access is not granted.
    public typealias Reader = @Sendable () throws -> [ContactsList.Record]?

    public static func make(reader: @escaping Reader = liveRecords) -> [any CapabilityHandler] {
        [Capability(CapabilitySpec(
            name: "contacts.list",
            description: "Contact names (with nickname and organization when set) for dictation vocabulary, ordered by family then given name. "
                + "Names only: no phone numbers, emails or addresses. Needs the Contacts permission; never prompts.",
            sideEffect: .read,
            inputSchema: Schema.object([
                "limit": Schema.integer("Default 500", min: 1, max: ContactsList.maxLimit),
                "fields": Schema.array(Schema.string(enum: ["name"]), description: "Only \"name\" for now"),
                "query": Schema.string("Prefix match on given or family name", maxLength: ContactsList.maxQuery),
                "offset": Schema.integer("Skip this many contacts first, to page past the limit; default 0", min: 0, max: ContactsList.maxOffset),
            ])
        )) { ctx in
            let (limit, offset, query) = try ContactsList.validate(try ctx.decode(ContactsList.Params.self))
            let records: [ContactsList.Record]? = try await withCheckedThrowingContinuation {
                (cont: CheckedContinuation<[ContactsList.Record]?, Error>) in
                DispatchQueue.global(qos: .userInitiated).async { cont.resume(with: Result { try reader() }) }
            }
            guard let records else {
                throw CapabilityError(.forbidden, reason: "permission_denied",
                                      "Psyche (Helper) does not have the Contacts permission", details: ["permission": "contacts"])
            }
            return CapabilityOutput(ContactsList.result(records: records, limit: limit, offset: offset, query: query))
        }]
    }

    static func displayName(_ c: CNContact) -> String {
        for candidate in [CNContactFormatter.string(from: c, style: .fullName) ?? "", c.organizationName, c.nickname] {
            let t = candidate.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { return t }
        }
        return ""
    }

    /// Live read through `CNContactStore`, fetching name keys only.
    @Sendable public static func liveRecords() throws -> [ContactsList.Record]? {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        guard status == .authorized else { return nil }
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor, CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor, CNContactNicknameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor, CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.sortOrder = .familyName
        request.unifyResults = true
        var out: [ContactsList.Record] = []
        do {
            try CNContactStore().enumerateContacts(with: request) { c, _ in
                out.append(ContactsList.Record(
                    // A card with no person name (a company, a nickname only) is listed by what it has.
                    id: c.identifier, name: displayName(c),
                    givenName: c.givenName, familyName: c.familyName, nickname: c.nickname, organization: c.organizationName
                ))
            }
        } catch {
            throw CapabilityError(.unavailable, reason: "contacts_store", "The contacts store could not be read", retryable: true)
        }
        return out
    }
}
