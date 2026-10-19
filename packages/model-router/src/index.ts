import { NotImplementedError, type ModelProvider } from "@psyche/protocol";

/**
 * Placeholder for the `ModelProvider` implementation owned by S03.
 * Build against `FakeModelProvider` from `@psyche/testing` until this lands.
 */
export function createModelRouter(): ModelProvider {
  throw new NotImplementedError("@psyche/model-router", "createModelRouter");
}
