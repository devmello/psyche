import Contacts
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Contacts wave 1 (P1–P3) behind a protocol, so capabilities are tested with a fake.
public protocol ContactsBackend: Sendable {
    /// Every contact as a summary (search ranks them in Swift).
    func summaries() async throws -> [ContactSummaryRecord]
    func read(id: String) async throws -> ContactRecord
    func create(_ input: ContactInputRecord) async throws -> ContactRecord
    func update(_ update: ContactUpdateRecord) async throws -> ContactRecord
}

/// CNContactStore. Asks for Contacts access on first use (the prompt is attributed as #570 says);
/// never fetches `CNContactNoteKey`.
public final class ContactsStoreBackend: ContactsBackend, @unchecked Sendable {
    private let store = CNContactStore()

    public init() {}

    func ensure() async throws {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return
        case .notDetermined:
            try HostAttribution.check(.contacts)
            if (try? await store.requestAccess(for: .contacts)) == true { return }
        default: break
        }
        throw CapabilityError.permissionMissing(.contacts)
    }

    static var summaryKeys: [CNKeyDescriptor] { [
        CNContactIdentifierKey as CNKeyDescriptor, CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    ] }

    static var fullKeys: [CNKeyDescriptor] { summaryKeys + [
        CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactJobTitleKey, CNContactPostalAddressesKey,
        CNContactUrlAddressesKey, CNContactBirthdayKey,
    ].map { $0 as CNKeyDescriptor } }

    static func summary(_ c: CNContact) -> ContactSummaryRecord {
        ContactSummaryRecord(id: c.identifier, name: CNContactFormatter.string(from: c, style: .fullName) ?? c.organizationName,
                             organization: c.organizationName, emails: c.emailAddresses.map { $0.value as String },
                             phones: c.phoneNumbers.map { $0.value.stringValue })
    }

    func record(_ c: CNContact) -> ContactRecord {
        let lv: (CNLabeledValue<NSString>) -> LabeledValueRecord = { LabeledValueRecord(label: ContactsWave1.label(fromStore: $0.label), value: $0.value as String) }
        let groups = ((try? store.groups(matching: nil)) ?? []).filter { g in
            let members = try? store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: g.identifier),
                                                     keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor])
            return members?.contains { $0.identifier == c.identifier } ?? false
        }.map(\.name)
        return ContactRecord(
            id: c.identifier, givenName: c.givenName, familyName: c.familyName, nickname: c.nickname, organization: c.organizationName,
            jobTitle: c.jobTitle, emails: c.emailAddresses.map(lv),
            phones: c.phoneNumbers.map { LabeledValueRecord(label: ContactsWave1.label(fromStore: $0.label), value: $0.value.stringValue) },
            addresses: c.postalAddresses.map {
                ContactAddressRecord(label: ContactsWave1.label(fromStore: $0.label), street: $0.value.street, city: $0.value.city, state: $0.value.state,
                                     postalCode: $0.value.postalCode, country: $0.value.country)
            },
            urls: c.urlAddresses.map(lv),
            birthday: c.birthday.flatMap { b in b.month.flatMap { m in b.day.map { ContactsWave1.birthdayString(year: b.year, month: m, day: $0) } } },
            groups: groups.sorted())
    }

    public func summaries() async throws -> [ContactSummaryRecord] {
        try await ensure()
        let request = CNContactFetchRequest(keysToFetch: Self.summaryKeys)
        request.unifyResults = true
        var out: [ContactSummaryRecord] = []
        do { try store.enumerateContacts(with: request) { c, _ in out.append(Self.summary(c)) } } catch {
            throw CapabilityError(.unavailable, reason: "contacts_store", "The contacts store could not be read", retryable: true)
        }
        return out
    }

    func fetch(_ id: String) throws -> CNContact {
        do { return try store.unifiedContact(withIdentifier: id, keysToFetch: Self.fullKeys) } catch {
            throw CapabilityError(.notFound, reason: "contact_not_found", "No contact \(id)")
        }
    }

    public func read(id: String) async throws -> ContactRecord {
        try await ensure()
        return record(try fetch(id))
    }

    static func apply(_ m: CNMutableContact, givenName: String?, familyName: String?, organization: String?, jobTitle: String?, birthday: String?) throws {
        if let v = givenName { m.givenName = v }
        if let v = familyName { m.familyName = v }
        if let v = organization { m.organizationName = v }
        if let v = jobTitle { m.jobTitle = v }
        if let b = birthday {
            let p = try ContactsWave1.birthday(b)
            var dc = DateComponents()
            dc.year = p.year
            dc.month = p.month
            dc.day = p.day
            m.birthday = dc
        }
    }

    static func emails(_ xs: [LabeledValueRecord]) -> [CNLabeledValue<NSString>] {
        xs.map { CNLabeledValue(label: ContactsWave1.storeLabel($0.label), value: $0.value as NSString) }
    }

    static func phones(_ xs: [LabeledValueRecord]) -> [CNLabeledValue<CNPhoneNumber>] {
        xs.map { CNLabeledValue(label: ContactsWave1.storeLabel($0.label), value: CNPhoneNumber(stringValue: $0.value)) }
    }

    func save(_ request: CNSaveRequest) throws {
        do { try store.execute(request) } catch {
            throw CapabilityError(.unavailable, reason: "contacts_save", "Contacts could not save the change (\((error as NSError).code))")
        }
    }

    public func create(_ input: ContactInputRecord) async throws -> ContactRecord {
        try await ensure()
        let m = CNMutableContact()
        try Self.apply(m, givenName: input.givenName, familyName: input.familyName, organization: input.organization, jobTitle: input.jobTitle,
                       birthday: input.birthday)
        m.emailAddresses = Self.emails(input.emails ?? [])
        m.phoneNumbers = Self.phones(input.phones ?? [])
        let r = CNSaveRequest()
        r.add(m, toContainerWithIdentifier: nil)
        try save(r)
        return record(try fetch(m.identifier))
    }

    public func update(_ u: ContactUpdateRecord) async throws -> ContactRecord {
        try await ensure()
        guard let m = try fetch(u.id).mutableCopy() as? CNMutableContact else { throw CapabilityError(.notFound, reason: "contact_not_found", "No contact \(u.id)") }
        try Self.apply(m, givenName: u.givenName, familyName: u.familyName, organization: u.organization, jobTitle: u.jobTitle, birthday: u.birthday)
        // Emails and phones are added, never replaced; ones already there are skipped.
        let haveEmails = Set(m.emailAddresses.map { ($0.value as String).lowercased() })
        m.emailAddresses += Self.emails((u.addEmails ?? []).filter { !haveEmails.contains($0.value.lowercased()) })
        let digits: (String) -> String = { String($0.filter(\.isNumber)) }
        let havePhones = Set(m.phoneNumbers.map { digits($0.value.stringValue) })
        m.phoneNumbers += Self.phones((u.addPhones ?? []).filter { !havePhones.contains(digits($0.value)) })
        let r = CNSaveRequest()
        r.update(m)
        try save(r)
        return record(try fetch(u.id))
    }
}
