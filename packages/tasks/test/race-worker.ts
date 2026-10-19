// Runs in a worker thread (Node type stripping): claims tasks from a shared on-disk database
// as fast as it can and reports every lease it won.
import { parentPort, workerData } from "node:worker_threads";
import { openDb } from "@psyche/db";
import { SqliteTaskEngine } from "../src/engine.ts";

const { file, owner, start } = workerData as { file: string; owner: string; start: Int32Array };
const db = openDb(file, { migrate: false });
let n = 0;
const engine = new SqliteTaskEngine({
  db,
  clock: { now: () => Date.now() },
  newId: () => `${owner}_${++n}`,
});
// Start together so the claims really overlap: report ready, then wait for the gun.
Atomics.add(start, 1, 1);
Atomics.notify(start, 1);
Atomics.wait(start, 0, 0);
const won: string[] = [];
for (;;) {
  const lease = await engine.claim(owner, { leaseMs: 600_000 });
  if (lease === undefined) break;
  won.push(lease.taskId);
  // Hold the lease briefly, as a real step would, so the other thread competes meanwhile.
  await new Promise((r) => setTimeout(r, 1));
  await engine.updateStatus(lease.taskId, "done");
}
db.close();
parentPort?.postMessage(won);
