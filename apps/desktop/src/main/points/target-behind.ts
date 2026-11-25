import type { PointsWindow } from "@psyche/protocol";

/**
 * Psyche points from the menu bar (docs/design/psyche-points-2026.md §6.2): "Point me through this
 * window…" means the window the owner was looking at, which is behind Psyche once Psyche's menu
 * is used. So Psyche hides first, waits for the system to hand the front to the window behind, and
 * asks the helper which window that is (`points.windows`, which lists the front one first). The
 * start sheet then opens with that window already chosen. Nothing starts here: Start is the
 * owner's click in the sheet, and a window the helper refuses is never chosen.
 */

export const SETTLE_MS = 250;

export interface TargetBehindDeps {
  /** Hides every Psyche window and gives the front back to the app behind (`app.hide()`). */
  hide: () => void;
  /** `points.windows` on the Gateway, over the desktop shell's own connection. */
  windows: () => Promise<{ windows: readonly PointsWindow[] }>;
  sleep: (ms: number) => Promise<void>;
  settleMs?: number;
}

/**
 * Hides Psyche and answers the ref of the frontmost window the helper allows, or undefined when
 * there is none or the helper can't say. The sheet opens either way (the owner can still pick).
 */
export async function targetBehind(deps: TargetBehindDeps): Promise<string | undefined> {
  deps.hide();
  await deps.sleep(deps.settleMs ?? SETTLE_MS);
  try {
    const { windows } = await deps.windows();
    return windows.find((w) => w.frontmost && w.refusal === undefined)?.ref;
  } catch {
    return undefined;
  }
}
