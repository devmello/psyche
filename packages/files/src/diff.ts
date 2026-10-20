/** Lines per side an approval card shows; the binding still covers the whole change. */
export const CARD_DIFF_LINES = 200;
/** Characters per card line. */
const CARD_LINE_CHARS = 400;

function capped(text: string, prefix: "-" | "+"): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const shown = lines
    .slice(0, CARD_DIFF_LINES)
    .map((l) => `${prefix}${l.length > CARD_LINE_CHARS ? `${l.slice(0, CARD_LINE_CHARS)}…` : l}`);
  if (lines.length > CARD_DIFF_LINES) {
    shown.push(`${prefix}… ${lines.length - CARD_DIFF_LINES} more lines`);
  }
  return shown;
}

/**
 * A unified-style diff for the approval card, built from the params alone (`describeCall` is
 * pure, so it never reads the file): the replaced text as `-` lines, the new text as `+` lines.
 */
export function cardDiff(path: string, before: string, after: string, note?: string): string {
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ ${note ?? "change"} @@`,
    ...capped(before, "-"),
    ...capped(after, "+"),
  ].join("\n");
}
