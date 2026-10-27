import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Psyche.app keeps one copy of the UI (docs/design/lightweight-2026.md, S2): the renderer build in
 * app.asar holds the web client too (`web.html`), and the bundled Gateway serves it from there
 * (apps/gateway/src/web-asar.ts), so the Gateway's own `apps/web/dist` (≈ 32 MB) is dropped from
 * the app. Standalone Gateway bundles and the Docker image keep theirs. Runs before osx-sign.
 *
 * `appDir` is Contents/Resources/app (the asar's contents, not yet packed); returns whether the copy
 * went. Nothing is removed unless the renderer build really carries the web client.
 */
export function dropGatewayWebCopy(appDir: string, resourcesDir: string): boolean {
  if (!existsSync(join(appDir, ".vite", "renderer", "main_window", "web.html"))) return false;
  const copy = join(resourcesDir, "psyched", "app", "apps", "web", "dist");
  if (!existsSync(copy)) return false;
  rmSync(copy, { recursive: true, force: true });
  return true;
}
