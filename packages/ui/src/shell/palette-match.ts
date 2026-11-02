/**
 * Whether an action answers the palette's search text: every word of it is in the label or the
 * hidden keywords (so "settings voice" and "voice settings" both find Settings → Voice).
 */
export function paletteMatches(
  action: { label: string; keywords?: string },
  text: string,
): boolean {
  const words = text.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${action.label} ${action.keywords ?? ""}`.toLocaleLowerCase();
  return words.every((w) => haystack.includes(w));
}
