import Foundation

/// Where the paired Gateway's endpoint is kept: one small JSON file in the app group container (so the
/// extensions can read it), with Application Support as the fallback where the group is not provisioned.
/// No secrets live here (the identity key is public). `FileProtectionType.completeUntilFirstUserAuthentication`
/// keeps it readable after the first unlock, like the device key.
public struct EndpointStore: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    /// The app group container's `Psyche/` folder, or Application Support's when there is no group.
    public static func standard() -> EndpointStore {
        EndpointStore(directory: AppGroup.dataDirectory)
    }

    private var fileURL: URL { directory.appendingPathComponent("endpoint.json") }

    /// The stored endpoint, revalidated: a file that was edited or came from an older build must still be an
    /// origin this phone would dial (https, or http only for loopback), or it counts as no pairing at all.
    public func load() -> GatewayEndpoint? {
        guard let data = try? Data(contentsOf: fileURL),
              let endpoint = try? JSONDecoder().decode(GatewayEndpoint.self, from: data),
              GatewayEndpoint.isDialableOrigin(endpoint.url)
        else { return nil }
        return endpoint
    }

    public func save(_ endpoint: GatewayEndpoint) throws {
        try AppGroup.prepareDirectory(directory)
        try JSONEncoder().encode(endpoint).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
