import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The workspace version (changesets bump every package together), shown in Settings → About. */
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const GATEWAY = "127.0.0.1:7979";
const DEV_PORT = 5173;
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}`;

/** Dev server only: allow the React refresh inline preamble and Vite's HMR socket. */
function devCsp(): Plugin {
  return {
    name: "psyche:dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:*");
    },
  };
}

export default defineConfig({
  base: "/",
  define: { __PSYCHE_APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), tailwindcss(), devCsp()],
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    host: "127.0.0.1",
    port: DEV_PORT,
    strictPort: true,
    // `pnpm dev` keeps the app same-origin with its Gateway endpoints by proxying them. Only an
    // upgrade coming from this dev page has its Origin mapped to the Gateway's own origin (as the
    // built app served at / would present); any other Origin passes through and the Gateway's
    // origin check rejects it.
    proxy: {
      "/healthz": { target: `http://${GATEWAY}` },
      "/version": { target: `http://${GATEWAY}` },
      "/ws": {
        target: `ws://${GATEWAY}`,
        ws: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (proxyReq, req) => {
            if (req.headers.origin === DEV_ORIGIN)
              proxyReq.setHeader("origin", `http://${GATEWAY}`);
          });
        },
      },
    },
  },
});
