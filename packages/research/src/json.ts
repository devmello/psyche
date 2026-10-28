/** Pulls the first JSON object out of a model reply (it may wrap it in prose or a fence). */
export function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export const asString = (v: unknown, max = 2_000): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** Whitespace- and quote-insensitive containment, so a quote survives re-wrapping. */
export function normalized(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}
