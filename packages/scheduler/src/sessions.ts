import { createThread, type PsycheDb } from "@psyche/db";
import type { SessionResolver } from "./types.ts";

/**
 * Session targets (architecture §4.11; OpenClaw `main` / `isolated` / `session:<id>`):
 * `main` runs in the owner's main thread; `isolated` gets a fresh `automation` thread per run
 * (`cron:<automationId>:<runId>`); `named:<id>` reuses one persistent thread across runs.
 */
export function createDbSessionResolver(db: PsycheDb): SessionResolver {
  const bySessionKey = (key: string) =>
    db.sqlite
      .prepare(
        "SELECT id FROM threads WHERE session_key = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1",
      )
      .get(key) as { id: string } | undefined;
  return {
    async resolve(target, { automation, runId }) {
      if (target === "main") {
        const main = db.sqlite
          .prepare(
            "SELECT id FROM threads WHERE kind = 'main' AND archived_at IS NULL ORDER BY created_at LIMIT 1",
          )
          .get() as { id: string } | undefined;
        return main?.id ?? createThread(db, { kind: "main", sessionKey: "main" }).id;
      }
      if (target === "isolated") {
        return createThread(db, {
          kind: "automation",
          sessionKey: `cron:${automation.id}:${runId}`,
          title: automation.title,
        }).id;
      }
      const name = /^named:(.+)$/.exec(target)?.[1];
      if (name === undefined) throw new Error(`unknown session target ${target}`);
      const key = `named:${name}`;
      return (
        bySessionKey(key)?.id ??
        createThread(db, { kind: "automation", sessionKey: key, title: automation.title }).id
      );
    },
  };
}
