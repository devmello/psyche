import { strToU8, zipSync } from "fflate";
import type { SqliteMemoryStore } from "./store.ts";
import { publicLesson } from "./teaching/service.ts";
import type { TeachingStore } from "./teaching/store.ts";

/**
 * Export everything (feature H7; architecture §2 principle 6: nothing the owner cannot export):
 * a zip of the workspace under `workspace/` plus `claims.json` with every claim, retracted ones
 * included, and a short `README.txt`.
 */
export async function exportMemory(
  store: SqliteMemoryStore,
  options: { teaching?: TeachingStore } = {},
): Promise<{ filename: string; data: Uint8Array }> {
  const files: Record<string, Uint8Array> = {};
  for (const path of await store.listFiles()) {
    const file = await store.readFile(path);
    if (file !== undefined) files[`workspace/${path}`] = strToU8(file.content);
  }
  const claims = await store.listClaims({ includeRetracted: true });
  files["claims.json"] = strToU8(`${JSON.stringify(claims, null, 2)}\n`);
  if (options.teaching !== undefined) {
    // The teaching loop (§3.5): every lesson (tombstones too) and the feedback still kept.
    const lessons = options.teaching.allLessons().map(publicLesson);
    files["lessons.json"] = strToU8(`${JSON.stringify(lessons, null, 2)}\n`);
    const events = [];
    let cursor: string | undefined;
    do {
      const page = options.teaching.listEvents({
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      events.push(...page.events);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    files["feedback.json"] = strToU8(`${JSON.stringify(events, null, 2)}\n`);
  }
  files["README.txt"] = strToU8(
    `Psyche memory export.\nworkspace/ holds your memory files exactly as they are on disk.\nclaims.json lists every remembered fact with its provenance, sources and state.\n${options.teaching === undefined ? "" : "lessons.json lists what Psyche learned from your feedback and where it wrote it; feedback.json the feedback it kept (180 days).\n"}`,
  );
  const stamp = new Date(store.clock.now()).toISOString().slice(0, 10);
  return { filename: `psyche-memory-${stamp}.zip`, data: zipSync(files, { level: 6 }) };
}
