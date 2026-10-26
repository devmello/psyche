import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const projectDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * The workspace version for Settings → About, as apps/web bakes it (#610). The desktop prefers
 * the bridge's `app.getVersion()`; this is the fallback when main does not answer.
 */
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/**
 * Dev server only: the React refresh preamble is an inline script and Vite's HMR client talks to
 * the dev server, so relax the CSP meta while serving. Production builds keep index.html's policy.
 */
function devCsp(): Plugin {
  return {
    name: "psyche:dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
    },
  };
}

export default defineConfig({
  root: `${projectDir}src/renderer`,
  // Forge defaults to "./"; nested routes (/chat/:id/pane/:paneId pop-outs) need absolute assets.
  base: "/",
  build: {
    // Forge's main process loads .vite/renderer/<name>/index.html relative to the app path.
    outDir: `${projectDir}.vite/renderer/main_window`,
    emptyOutDir: true,
  },
  resolve: {
    // Forge enables preserveSymlinks; with pnpm workspaces that duplicates React. Turn it off.
    preserveSymlinks: false,
    dedupe: ["react", "react-dom"],
  },
  define: { __PSYCHE_APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), tailwindcss(), devCsp()],
});
