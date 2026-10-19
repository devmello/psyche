import { NotImplementedError, type PermissionBroker } from "@psyche/protocol";

/**
 * Placeholder for the `PermissionBroker` implementation owned by S05.
 * Build against `FakePermissionBroker` from `@psyche/testing` until this lands.
 */
export function createPermissionBroker(): PermissionBroker {
  throw new NotImplementedError("@psyche/permissions", "createPermissionBroker");
}
