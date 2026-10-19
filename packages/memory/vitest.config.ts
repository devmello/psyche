import { defineConfig } from "vitest/config";

// Many tests create a workspace, a database and the index from scratch; on a loaded machine a
// few of them pass the 5 s default, so they get more room (none waits on real time).
export default defineConfig({
  test: { testTimeout: 20_000 },
});
