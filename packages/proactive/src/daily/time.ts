export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
  weekday: number;
}

export function localParts(ms: number, timezone: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: days.indexOf(get("weekday")),
  };
}

/** Epoch ms of local midnight starting the day that contains `ms`. */
export function startOfLocalDay(ms: number, timezone: string): number {
  const p = localParts(ms, timezone);
  return ms - ((p.hour * 60 + p.minute) * 60_000 + (ms % 60_000));
}

/** Epoch ms of `hour:00` local on the day `days` after the day containing `ms`. */
export function localAt(ms: number, timezone: string, days: number, hour: number): number {
  const start = startOfLocalDay(ms, timezone) + days * 86_400_000;
  // DST shifts the day by an hour at most; re-anchor on the resulting local hour.
  const guess = start + hour * 3_600_000;
  const p = localParts(guess, timezone);
  return guess - (p.hour - hour) * 3_600_000 - p.minute * 60_000;
}
