/** The browser's time zone, e.g. "America/Los_Angeles"; empty when it can't say. */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
