import { t } from "./core.ts";
import type { MessageId } from "./messages/index.ts";

/** `t` for ids built from data (`capabilities.${id}.title`); the catalogue test covers the ids. */
export function tk(id: string, values?: Record<string, string | number>): string {
  return t(id as MessageId, values);
}
