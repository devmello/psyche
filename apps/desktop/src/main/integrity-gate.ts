import type { ShortcutRegistry } from "./dictation/service.ts";

/**
 * The startup signature check, off the first window's critical path. The check runs in the
 * background; until it has settled `blocked()` is true, so the TCC-backed features (helper, Ask
 * about screen, dictation) cannot start on a copy that has not been verified yet. It never defaults
 * to "not blocked" while pending. A check that itself throws is treated as before: warned about and
 * not blocking.
 */
export interface IntegrityGate {
  /** True while the check is pending and after it found the signature broken. */
  blocked(): boolean;
  /** True once the check has finished (either way). */
  isSettled(): boolean;
  /** Resolves after the check; never rejects. */
  readonly settled: Promise<void>;
}

export function createIntegrityGate(
  check: () => Promise<boolean>,
  warn: (message: string) => void = () => {},
): IntegrityGate {
  let state: "pending" | "ok" | "blocked" = "pending";
  const settled = Promise.resolve()
    .then(check)
    .then(
      (isBlocked) => {
        state = isBlocked ? "blocked" : "ok";
      },
      (err: unknown) => {
        warn(`[integrity] ${String(err)}`);
        state = "ok";
      },
    );
  return {
    blocked: () => state !== "ok",
    isSettled: () => state !== "pending",
    settled,
  };
}

/**
 * A shortcut registry that registers nothing until the gate has settled, and nothing at all when
 * the check blocked. While pending, `register` reports success and remembers the accelerator.
 */
export function gateShortcuts(inner: ShortcutRegistry, gate: IntegrityGate): ShortcutRegistry {
  const pending = new Map<string, () => void>();
  void gate.settled.then(() => {
    if (!gate.blocked()) for (const [accelerator, cb] of pending) inner.register(accelerator, cb);
    pending.clear();
  });
  return {
    register(accelerator, cb) {
      if (!gate.isSettled()) {
        pending.set(accelerator, cb);
        return true;
      }
      if (gate.blocked()) return true;
      return inner.register(accelerator, cb);
    },
    unregister(accelerator) {
      pending.delete(accelerator);
      if (gate.isSettled() && !gate.blocked()) inner.unregister(accelerator);
    },
  };
}
