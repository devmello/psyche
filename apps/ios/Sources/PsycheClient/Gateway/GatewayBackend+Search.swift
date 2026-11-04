import Foundation
import PsycheStore

// Search is I7's screen; the Gateway wiring (`search.query`) comes later.
extension GatewayBackend {
    public func search(query: String) async throws -> SearchResults { throw BackendError.unreachable }
}
