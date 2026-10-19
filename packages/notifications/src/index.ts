import { NotImplementedError, type Notifier } from "@psyche/protocol";

/**
 * Placeholder for the `Notifier` implementation owned by S15.
 * Build against `FakeNotifier` from `@psyche/testing` until this lands.
 */
export function createNotifier(): Notifier {
  throw new NotImplementedError("@psyche/notifications", "createNotifier");
}
