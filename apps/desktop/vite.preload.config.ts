import { defineConfig } from "vite";

// Preload bundle (sandboxed: only `electron`'s renderer-safe modules are available at runtime).
// Sourcemaps only in development or with PSYCHE_SOURCEMAPS=1 (see vite.main.config.ts).
export default defineConfig(({ mode }) => ({
  build: { sourcemap: mode === "development" || process.env.PSYCHE_SOURCEMAPS === "1" },
}));
