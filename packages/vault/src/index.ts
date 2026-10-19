import { type CredentialBroker, NotImplementedError } from "@psyche/protocol";

/**
 * Placeholder for the `CredentialBroker` implementation owned by S06.
 * Build against `FakeCredentialBroker` from `@psyche/testing` until this lands.
 */
export function createCredentialBroker(): CredentialBroker {
  throw new NotImplementedError("@psyche/vault", "createCredentialBroker");
}
