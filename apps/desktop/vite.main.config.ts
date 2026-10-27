import { defineConfig } from "vite";

// Main-process bundle. Forge's plugin-vite supplies the entry, CJS output and the Electron externals.
// node-pty is a native module: it stays external and is copied next to the bundle at package time
// (forge.config.ts packageAfterPrune). electron-liquid-glass (the Liquid Glass spike's addon, not a
// dependency; a probe installs it locally) stays external too; bundling it breaks its native loader.
// Sourcemaps only in development (`electron-forge start`) or with PSYCHE_SOURCEMAPS=1: in a
// packaged app they were 59 MB of app.asar (docs/archive/reports/v1-bundle-size.md).
export default defineConfig(({ mode }) => ({
  build: {
    sourcemap: mode === "development" || process.env.PSYCHE_SOURCEMAPS === "1",
    rollupOptions: { external: ["node-pty", "electron-liquid-glass"] },
  },
}));
