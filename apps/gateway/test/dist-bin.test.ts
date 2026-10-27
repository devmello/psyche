import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The self-contained Gateway bundle for Psyche.app (deploy/scripts/build-psyched.mjs; docs/archive/status/
 * s22.md "Packaging layout"). Runs only when a bundle has been built on this machine
 * (`node deploy/scripts/build-psyched.mjs`): it starts the built `psyched` with nothing but
 * PSYCHE_HOME in its environment (no PATH, no Node, no checkout) and checks /healthz.
 */

const BUNDLE = resolve(
  import.meta.dirname,
  "../dist-bin",
  `darwin-${arch() === "arm64" ? "arm64" : "x64"}`,
  "psyched",
);
const built = process.platform === "darwin" && existsSync(join(BUNDLE, "psyched"));

describe.skipIf(!built)("psyched bundle (dist-bin)", () => {
  it("has the layout the desktop copies into Contents/Resources/psyched", () => {
    for (const f of ["psyched", "psyche", "runtime/node"]) {
      expect(statSync(join(BUNDLE, f)).mode & 0o111, f).not.toBe(0);
    }
    expect(existsSync(join(BUNDLE, "app/apps/gateway/dist/main.mjs"))).toBe(true);
    expect(existsSync(join(BUNDLE, "app/apps/web/dist/index.html"))).toBe(true);
    expect(existsSync(join(BUNDLE, "app/packages/db/migrations"))).toBe(true);
    const template = readFileSync(join(BUNDLE, "com.psyche.gateway.plist.template"), "utf8");
    expect(template).toContain("<string>{{PSYCHED}}</string>");
    expect(template).toContain("<string>{{PSYCHE_HOME}}</string>");
    const info = JSON.parse(readFileSync(join(BUNDLE, "build-info.json"), "utf8")) as {
      node: string;
      arch: string;
    };
    expect(info.node).toMatch(/^24\.\d+\.\d+$/);
  });

  it("starts with only PSYCHE_HOME set and answers /healthz", async () => {
    const home = mkdtempSync(join("/tmp", "psy-bin-"));
    const child = spawn(join(BUNDLE, "psyched"), [], {
      env: { PSYCHE_HOME: home, PSYCHE_PORT: "0", PSYCHE_BROWSER: "off" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const origin = await new Promise<string>((ok, fail) => {
        let buf = "";
        const t = setTimeout(() => fail(new Error(`psyched did not start:\n${buf}`)), 30_000);
        child.stderr?.on("data", (d) => {
          buf += String(d);
          const m = /"msg":"gateway listening","origin":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(buf);
          if (m?.[1]) {
            clearTimeout(t);
            ok(m[1]);
          }
        });
        child.on("exit", (code) => {
          clearTimeout(t);
          fail(new Error(`psyched exited ${code}:\n${buf}`));
        });
      });
      expect(await (await fetch(`${origin}/healthz`)).json()).toEqual({ ok: true });
      // The web client is served from the bundle.
      expect((await fetch(`${origin}/`)).headers.get("content-type")).toContain("text/html");
      expect(existsSync(join(home, "state", "psyche.sqlite"))).toBe(true);
    } finally {
      child.kill("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
