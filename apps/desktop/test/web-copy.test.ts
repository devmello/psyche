import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dropGatewayWebCopy } from "../src/packaging/web-copy.ts";

function layout(withWebHtml: boolean) {
  const resources = mkdtempSync(join(tmpdir(), "psyche-webcopy-"));
  const app = join(resources, "app");
  const renderer = join(app, ".vite/renderer/main_window");
  const copy = join(resources, "psyched/app/apps/web/dist");
  mkdirSync(renderer, { recursive: true });
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(renderer, "index.html"), "<html>");
  if (withWebHtml) writeFileSync(join(renderer, "web.html"), "<html>");
  writeFileSync(join(copy, "index.html"), "<html>");
  return { resources, app, copy };
}

describe("dropGatewayWebCopy", () => {
  it("drops the Gateway's web build when the renderer build carries web.html", () => {
    const { resources, app, copy } = layout(true);
    try {
      expect(dropGatewayWebCopy(app, resources)).toBe(true);
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(join(resources, "psyched/app/apps"))).toBe(true);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  it("keeps it when the renderer build has no web client", () => {
    const { resources, app, copy } = layout(false);
    try {
      expect(dropGatewayWebCopy(app, resources)).toBe(false);
      expect(existsSync(copy)).toBe(true);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});
