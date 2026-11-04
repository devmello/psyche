import Foundation
import PsycheStore

// Memory is I7's screen; the Gateway wiring comes later (see the stub note in GatewayBackend+Library.swift).
extension GatewayBackend {
    public func memory() async throws -> MemorySnapshot { throw BackendError.unreachable }
    public func setTodo(id: String, done: Bool) async throws { throw BackendError.unreachable }
    public func person(id: String) async throws -> PersonDetail { throw BackendError.unreachable }
    public func project(id: String) async throws -> ProjectDetail { throw BackendError.unreachable }
}
