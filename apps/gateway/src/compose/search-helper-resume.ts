/**
 * What lets Apple reads resume after the Host's helper was refused (`search-apple.ts`): a connect
 * of the Host helper, or an approved pairing (`device.updated` from `devices.approve`). Either one
 * clears the block and runs a source tick at once. Kept apart from `search.ts` so it can be tested
 * without the whole search composition.
 */
export interface HelperResumeDeps {
  /** Whether the Host's helper is connected right now. */
  helperConnected: () => boolean;
  /** Clears the Apple block (`AppleSourceDeps.resumeHelper`). */
  resumeHelper: () => void;
  /** One source pass now. */
  tick: () => Promise<void> | void;
}

export type HelperResumeTrigger = "connect" | "approval";

/** The bus event an approved pairing emits (`devices.approve`). */
export const PAIRING_APPROVED_EVENT = "device.updated";

/**
 * The handler a trigger calls. A connect while no helper is up does nothing. An approval clears
 * the block even when the helper is not up, so the next read is attempted, not the one after.
 */
export function helperResumeHandler(
  deps: HelperResumeDeps,
): (trigger: HelperResumeTrigger) => void {
  return (trigger) => {
    if (trigger === "connect" && !deps.helperConnected()) return;
    deps.resumeHelper();
    void Promise.resolve()
      .then(() => deps.tick())
      .catch(() => undefined);
  };
}
