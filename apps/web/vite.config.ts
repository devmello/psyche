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

const DEV_PORT = 5173;

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
  server: { host: "127.0.0.1", port: DEV_PORT, strictPort: true },
});
