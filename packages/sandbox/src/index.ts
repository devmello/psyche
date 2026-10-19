import { NotImplementedError, type SandboxRunner } from "@psyche/protocol";

/**
 * Placeholder for the `SandboxRunner` implementation owned by C1.
 * Build against `FakeSandboxRunner` from `@psyche/testing` until this lands.
 */
export function createSandboxRunner(): SandboxRunner {
  throw new NotImplementedError("@psyche/sandbox", "createSandboxRunner");
}
