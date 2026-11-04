import Foundation
import PsycheStore

// Library is I6's screen; the Gateway wiring comes later. Until then every call says the Gateway is
// out of reach rather than returning made-up content. When the Library protocol gains a method, add
// its stub here.
extension GatewayBackend {
    public func library(section: LibrarySection) async throws -> [LibraryItem] { throw BackendError.unreachable }
    public func libraryFile(id: String) async throws -> URL? { throw BackendError.unreachable }
    public func upload(_ file: UploadFile) async throws -> LibraryItem { throw BackendError.unreachable }
    public func deleteLibraryItem(id: String) async throws { throw BackendError.unreachable }
}
