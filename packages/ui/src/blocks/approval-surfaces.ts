import { isOffMacSurface } from "@psyche/protocol";

/**
 * The other places an approval card was sent, as the card names them. A paired phone's own
 * `device:<deviceId>` surface (where it taps the card with its own token) is not one to name:
 * it would print device ids, so it is hidden.
 */
export function otherSurfacesFor(
  surfaces: readonly string[],
  hide: readonly string[] = ["desktop"],
): string[] {
  // The off-Mac marker (and a stored legacy `web`) is routing, not a place to name.
  return surfaces.filter(
    (s) => !hide.includes(s) && !isOffMacSurface(s) && !s.startsWith("device:"),
  );
}
