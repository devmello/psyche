import { cachedGraphicalSession, type GraphicalSessionCheck } from "./computer-linux.ts";

/**
 * A headless Linux Host (linux-helper-only design track B): logind reports no graphical session
 * for this user (B0's `hasGraphicalSession`, owner decision on B3 r1: never psyched's own
 * environment). Then no desktop window can serve the browser bridge and polkit can't ask for the
 * password, so the agent browser runs headless Chromium and payments need a passkey (B3).
 *
 * One shared answer per few seconds (`cachedGraphicalSession`'s TTL) for the browser and the
 * payment rule. Off Linux it is always "graphical": nothing here is headless.
 */
let shared: GraphicalSessionCheck | undefined;

export function hostGraphicalSession(
  platform: NodeJS.Platform = process.platform,
): GraphicalSessionCheck {
  if (platform !== "linux") return async () => true;
  shared ??= cachedGraphicalSession();
  return shared;
}

/** Whether this is a headless Linux Host now (see above). */
export async function headlessLinuxHost(
  platform: NodeJS.Platform = process.platform,
  graphical: GraphicalSessionCheck = hostGraphicalSession(platform),
  signal?: AbortSignal,
): Promise<boolean> {
  if (platform !== "linux") return false;
  return !(await graphical(signal));
}
