import type { BrowserPort } from "../platform.ts";

/**
 * What the new-tab field accepts: an address, with `https://` assumed when no scheme is typed.
 * Null for empty input or a scheme the built-in browser refuses (main re-checks http/https).
 */
export function normalizeTabUrl(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export type NewTabResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: "invalid" | "failed" };

/** Opens `input` in a new tab and makes it the active one. */
export async function openNewTab(
  port: Pick<BrowserPort, "openTab" | "activateTab">,
  input: string,
): Promise<NewTabResult> {
  const url = normalizeTabUrl(input);
  if (url === null) return { ok: false, reason: "invalid" };
  try {
    const tabId = await port.openTab(url);
    await port.activateTab(tabId);
    return { ok: true, tabId };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
