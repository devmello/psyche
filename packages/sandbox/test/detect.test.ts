import { describe, expect, it } from "vitest";
import type { ContainerBackendKind } from "../src/backends.ts";
import { type DetectDeps, detectBackends, parseBackendOverride } from "../src/detect.ts";

function deps(overrides: Partial<DetectDeps> & { working?: string[] } = {}): DetectDeps {
  const working = new Set(overrides.working ?? ["container", "docker", "podman"]);
  return {
    platform: "darwin",
    arch: "arm64",
    env: {},
    which: async (cmd) => `/usr/local/bin/${cmd}`,
    macosVersion: async () => "26.1",
    probe: async (cli) => {
      const name = cli.split("/").at(-1) ?? "";
      return working.has(name) ? "1.0" : null;
    },
    ...overrides,
  };
}

const kinds = async (d: DetectDeps, backend?: ContainerBackendKind) =>
  (await detectBackends(d, backend === undefined ? {} : { backend })).map((b) => b.kind);

describe("backend detection order", () => {
  it("prefers Apple container, then Docker, then Podman on macOS 26+", async () => {
    expect(await kinds(deps())).toEqual(["apple-container", "docker", "podman"]);
  });

  it("skips Apple container before macOS 26 and on Intel Macs", async () => {
    expect(await kinds(deps({ macosVersion: async () => "15.6" }))).toEqual(["docker", "podman"]);
    expect(await kinds(deps({ arch: "x64" }))).toEqual(["docker", "podman"]);
  });

  it("uses Docker then Podman on Linux and never Apple container", async () => {
    expect(await kinds(deps({ platform: "linux", macosVersion: async () => null }))).toEqual([
      "docker",
      "podman",
    ]);
  });

  it("skips a backend whose CLI is missing or whose service does not answer", async () => {
    const which = async (cmd: string) => (cmd === "podman" ? null : `/bin/${cmd}`);
    expect(await kinds(deps({ which, working: ["container"] }))).toEqual(["apple-container"]);
  });

  it("returns nothing when no backend works: there is no host fallback", async () => {
    expect(await kinds(deps({ working: [] }))).toEqual([]);
  });

  it("an explicit override restricts detection to that backend", async () => {
    expect(await kinds(deps(), "docker")).toEqual(["docker"]);
    expect(await kinds(deps({ env: { PSYCHE_SANDBOX_BACKEND: "podman" } }))).toEqual(["podman"]);
    // An override that is not available yields nothing rather than another backend.
    expect(await kinds(deps({ working: ["container"] }), "docker")).toEqual([]);
  });

  it("rejects an unknown override", () => {
    expect(() => parseBackendOverride("host")).toThrow(/not a sandbox backend/);
    expect(parseBackendOverride("")).toBeUndefined();
  });

  it("uses the configured CLI path", async () => {
    const seen: string[] = [];
    const d = deps({
      which: async (cmd) => {
        seen.push(cmd);
        return cmd;
      },
      probe: async () => "1",
    });
    const found = await detectBackends(d, {
      backend: "docker",
      cliPaths: { docker: "/opt/x/docker" },
    });
    expect(seen).toEqual(["/opt/x/docker"]);
    expect(found[0]?.cli).toBe("/opt/x/docker");
  });
});
