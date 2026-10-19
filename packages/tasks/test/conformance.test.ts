import { describeTaskEngineConformance } from "@psyche/testing/conformance";
import { SqliteTaskEngine } from "../src/index.ts";
import { testDb } from "./helpers.ts";

describeTaskEngineConformance("SqliteTaskEngine", ({ clock, ids }) => {
  const db = testDb(clock, ":memory:", ["thr_conf"]);
  return new SqliteTaskEngine({ db, clock, newId: () => ids.next() });
});
