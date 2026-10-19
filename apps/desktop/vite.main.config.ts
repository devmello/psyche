import { defineConfig } from "vite";

// Main-process bundle. Forge's plugin-vite supplies the entry, CJS output and the Electron externals.
export default defineConfig({
  build: { sourcemap: true },
});
