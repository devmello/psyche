/** Durations and relative times (`lib/format.ts`; UI design §4.12 copy voice). */
export const time = {
  "time.ms": "{n, number} ms",
  "time.s": "{n, number} s",
  "time.min": "{n, number} min",
  "time.h": "{h, number} h",
  "time.hMin": "{h, number} h {m, number} min",
  "time.days": "{n, plural, one {# day} other {# days}}",
  "time.justNow": "just now",
  "time.ago": "{label} ago",
  "time.in": "in {label}",
  "time.yesterday": "yesterday",
  "time.tomorrow": "tomorrow",
  "time.onDate": "on {date}",
} as const;
