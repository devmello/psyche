import { type MemoryStore, NotImplementedError } from "@psyche/protocol";

/**
 * Placeholder for the `MemoryStore` implementation owned by S07.
 * Build against `FakeMemoryStore` from `@psyche/testing` until this lands.
 */
export function createMemoryStore(): MemoryStore {
  throw new NotImplementedError("@psyche/memory", "createMemoryStore");
}
