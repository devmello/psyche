import { defineConfig } from "vite";

// Preload bundle (sandboxed: only `electron`'s renderer-safe modules are available at runtime).
export default defineConfig({
  build: { sourcemap: true },
});
