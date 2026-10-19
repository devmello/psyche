import { strToU8, zipSync } from "fflate";
import type { SqliteMemoryStore } from "./store.ts";

/**
 * Export everything (feature H7; architecture §2 principle 6: nothing the owner cannot export):
 * a zip of the workspace under `workspace/` plus `claims.json` with every claim, retracted ones
 * included, and a short `README.txt`.
 */
export async function exportMemory(
  store: SqliteMemoryStore,
): Promise<{ filename: string; data: Uint8Array }> {
  const files: Record<string, Uint8Array> = {};
  for (const path of await store.listFiles()) {
    const file = await store.readFile(path);
    if (file !== undefined) files[`workspace/${path}`] = strToU8(file.content);
  }
  const claims = await store.listClaims({ includeRetracted: true });
  files["claims.json"] = strToU8(`${JSON.stringify(claims, null, 2)}\n`);
  files["README.txt"] = strToU8(
    "Psyche memory export.\nworkspace/ holds your memory files exactly as they are on disk.\nclaims.json lists every remembered fact with its provenance, sources and state.\n",
  );
  const stamp = new Date(store.clock.now()).toISOString().slice(0, 10);
  return { filename: `psyche-memory-${stamp}.zip`, data: zipSync(files, { level: 6 }) };
}
