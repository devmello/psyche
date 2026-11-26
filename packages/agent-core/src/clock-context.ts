import type { TurnContextProvider } from "./turn-context.ts";

/**
 * The owner's local date, time and zone, so "tomorrow at 9", "in 2 minutes" and "what time is
 * it" resolve without asking. Our own text (no owner data), so a trusted turn-context section:
 * it adds no taint. Read per owner turn, so it is never stale.
 */
export function clockLine(now: number, timeZone: string): string {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace("GMT", "UTC") || "UTC";
  return `It is ${get("weekday")} ${get("year")}-${get("month")}-${get("day")}, ${get("hour")}:${get("minute")} (24-hour clock) in ${zone} (${offset === "UTC" ? "UTC+00:00" : offset}). That is the owner's local time: use it for "today", "tomorrow", "in 5 minutes" and "what time is it". Never ask the owner for their time zone.`;
}

/** The turn-context provider for `clockLine`; every owner turn. */
export function clockContextProvider(options: {
  now: () => number;
  timeZone: () => string;
}): TurnContextProvider {
  return {
    name: "clock",
    async provide() {
      return {
        sections: [{ title: "Local time", text: clockLine(options.now(), options.timeZone()) }],
        source: { sourceKind: "clock" },
        trusted: true,
      };
    },
  };
}
