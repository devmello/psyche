import { createHash } from "node:crypto";
import type { WatchRow } from "./rows.ts";

export interface WatchVerdict {
  /** Stored as `last_value`. */
  value: string | null;
  /** Stored as `alerted_value`: what the last alert was about (dedupe). */
  alertedValue: string | null;
  alert: boolean;
  summary: string;
}

/** Fetched text beyond this is ignored (the connectors' fetch caps size too). */
export const MAX_PAGE_CHARS = 1_000_000;
/** How much text after the selector marker a check looks at. */
export const REGION_CHARS = 2_000;

/** A grouped number needs at least one `,ddd` group; otherwise all digits are taken. */
const PRICE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/;

/**
 * The text a check looks at. `selector` is a literal marker (no regular expressions: page text
 * is untrusted and a regex could be made to backtrack for minutes): the region is the
 * `REGION_CHARS` characters after its first occurrence. `null` when the marker is missing.
 */
function region(w: WatchRow, text: string): string | null {
  const page = text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
  if (w.selector === null) return page;
  const at = page.indexOf(w.selector);
  if (at < 0) return null;
  const start = at + w.selector.length;
  return page.slice(start, start + REGION_CHARS);
}

export function parsePrice(text: string): number | undefined {
  const m = PRICE.exec(text);
  if (m?.[1] === undefined) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Evaluates one check (feature O3). Alerts fire on a transition only: content that differs from
 * the previous observation, text appearing, a price crossing its threshold. While a condition
 * stays true no new alert is raised; once it clears, the next crossing alerts again. A missing
 * selector marker (a consent or error page) is no observation: nothing changes.
 */
export function evaluateWatch(w: WatchRow, text: string): WatchVerdict {
  const extra = (w.threshold === null ? {} : JSON.parse(w.threshold)) as {
    threshold?: number;
    text?: string;
  };
  const part = region(w, text);
  if (part === null && w.kind !== "text_present") {
    return {
      value: w.last_value,
      alertedValue: w.alerted_value,
      alert: false,
      summary: "The selector was not found on the page",
    };
  }
  switch (w.kind) {
    case "change": {
      const normalized = (part ?? "").replace(/\s+/g, " ").trim();
      const value = `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
      if (w.last_value === null) {
        return { value, alertedValue: null, alert: false, summary: "Baseline recorded" };
      }
      const alert = value !== w.last_value;
      return {
        value,
        alertedValue: alert ? value : w.alerted_value,
        alert,
        summary: alert ? `The page changed: ${w.url}` : "No change",
      };
    }
    case "text_present": {
      const needle = extra.text;
      const present = part !== null && (needle === undefined || part.includes(needle));
      const alert = present && w.alerted_value !== "present";
      return {
        value: present ? "present" : "absent",
        alertedValue: present ? "present" : null,
        alert,
        summary: alert
          ? `"${needle ?? w.selector}" is now on ${w.url}`
          : present
            ? "Still present"
            : "Not present",
      };
    }
    default: {
      const threshold = extra.threshold ?? Number.NaN;
      const price = parsePrice(part ?? "");
      if (price === undefined) {
        return {
          value: w.last_value,
          alertedValue: w.alerted_value,
          alert: false,
          summary: "No price found on the page",
        };
      }
      const crossed = w.kind === "price_below" ? price <= threshold : price >= threshold;
      const alert = crossed && w.alerted_value === null;
      return {
        value: String(price),
        alertedValue: crossed ? (w.alerted_value ?? String(price)) : null,
        alert,
        summary: alert
          ? `Price ${price} is ${w.kind === "price_below" ? "at or below" : "at or above"} ${threshold}: ${w.url}`
          : `Price ${price}`,
      };
    }
  }
}
