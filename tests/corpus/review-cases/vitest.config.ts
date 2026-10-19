import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// S23 review cases. Not part of the root `projects` list on purpose: these tests are expected
// to FAIL until the reviewed package fixes the finding. Run them with
//   pnpm exec vitest run --config tests/corpus/review-cases/vitest.config.ts [pr-<n>]
// S18 can move passing cases into the gated corpus once they hold.
const root = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@psyche/protocol": `${root}packages/protocol/src/index.ts`,
      "@psyche/gateway": `${root}apps/gateway/src/index.ts`,
      ws: `${root}apps/gateway/node_modules/ws/wrapper.mjs`,
    },
  },
  test: { root: fileURLToPath(new URL(".", import.meta.url)), include: ["**/*.test.ts"] },
});
