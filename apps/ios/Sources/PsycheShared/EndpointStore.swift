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

    public func load() -> GatewayEndpoint? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(GatewayEndpoint.self, from: data)
    }

    public func save(_ endpoint: GatewayEndpoint) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(endpoint).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
