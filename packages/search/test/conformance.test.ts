import { describeSearchIndexConformance } from "@psyche/testing/conformance";
import { createSearchIndex } from "../src/index.ts";

describeSearchIndexConformance("SqliteSearchIndex", (ctx) =>
  createSearchIndex({ now: () => ctx.clock.now() }),
);
