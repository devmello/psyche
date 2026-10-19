import { defineConfig } from "vite";

// Main-process bundle. Forge's plugin-vite supplies the entry, CJS output and the Electron externals.
// node-pty is a native module: it stays external and is copied next to the bundle at package time
// (forge.config.ts packageAfterPrune).
export default defineConfig({
  build: { sourcemap: true, rollupOptions: { external: ["node-pty"] } },
});
