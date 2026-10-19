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

const PRICE = /(?:[$€£¥]\s?)?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/;

/** Text the check looks at: capture group 1 (or the whole match) of `selector`, else the page. */
function region(w: WatchRow, text: string): string | null {
  if (w.selector === null) return text;
  const m = new RegExp(w.selector, "s").exec(text);
  if (m === null) return null;
  return m[1] ?? m[0];
}

export function parsePrice(text: string): number | undefined {
  const m = PRICE.exec(text);
  if (m?.[1] === undefined) return undefined;
  const n = Number(m[1].replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Evaluates one check (feature O3). Alerts fire on a transition only: the first change after a
 * baseline, text appearing, a price crossing its threshold. While the condition stays true no
 * new alert is raised; once it clears, the next crossing alerts again.
 */
export function evaluateWatch(w: WatchRow, text: string): WatchVerdict {
  const extra = (w.threshold === null ? {} : JSON.parse(w.threshold)) as {
    threshold?: number;
    text?: string;
  };
  const part = region(w, text);
  switch (w.kind) {
    case "change": {
      const normalized = (part ?? "").replace(/\s+/g, " ").trim();
      const value = `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
      if (w.last_value === null) {
        return { value, alertedValue: null, alert: false, summary: "Baseline recorded" };
      }
      const alert = value !== w.last_value && value !== w.alerted_value;
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
      const price = part === null ? undefined : parsePrice(part);
      if (price === undefined) {
        return {
          value: null,
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
