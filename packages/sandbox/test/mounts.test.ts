import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runArgs } from "../src/backends.ts";
import { ContainerSandboxRunner } from "../src/runner.ts";
import { validateMounts } from "../src/validate.ts";
import { FakeDriver } from "./fake-driver.ts";

/** Bind mounts of granted host folders (V10 coding workspaces; security §5.1, §13). */

let dir: string;
let repo: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-mounts-")));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const repoMounts = () => [
  { source: join(repo, ".git"), target: "/workspace/repo/.git", readOnly: true },
  { source: repo, target: "/workspace/repo", readOnly: false },
];

async function code(p: Promise<unknown>): Promise<string | undefined> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  return e instanceof PsycheError ? e.code : e === undefined ? undefined : String(e);
}

describe("validateMounts", () => {
  it("accepts real folders under /workspace and orders parents first", async () => {
    const m = await validateMounts(repoMounts());
    expect(m.map((x) => x.target)).toEqual(["/workspace/repo", "/workspace/repo/.git"]);
  });

  it("refuses symlinked sources, never-shared roots and targets outside /workspace", async () => {
    symlinkSync(repo, join(dir, "link"));
    const one = (source: string, target = "/workspace/x", extra: string[] = []) =>
      code(validateMounts([{ source, target, readOnly: true }], extra));
    expect(await one(join(dir, "link"))).toBe("forbidden");
    expect(await one("/")).toBe("forbidden");
    expect(await one(homedir())).toBe("forbidden");
    expect(await one(repo, "/etc")).toBe("forbidden");
    expect(await one(repo, "/workspace/../etc")).toBe("forbidden");
    expect(await one(repo, "/workspace/a,readonly=false")).toBe("forbidden");
    expect(await one(repo, "/workspace/x", [dir])).toBe("forbidden");
    // An ancestor of a protected root would expose it too.
    expect(await one(dir, "/workspace/x", [join(dir, "repo/psyche-home")])).toBe("forbidden");
    expect(await one(join(dir, "missing"))).toBe("not_found");
  });
});

describe("runner bind mounts (fake CLI)", () => {
  function setup() {
    const driver = new FakeDriver();
    driver.respond = (args) =>
      args[0] === "inspect" || (args[0] === "volume" && args[1] === "inspect")
        ? { exitCode: 1 }
        : undefined;
    const runner = new ContainerSandboxRunner({
      driver,
      detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
      image: "psyche-sandbox:core-dev",
      idleTimeoutMs: 0,
    });
    return { driver, runner };
  }

  it("passes each mount as --mount type=bind and reports them on the instance", async () => {
    const { driver, runner } = setup();
    const scope = { kind: "project" as const, id: "cw_1" };
    const sbx = await runner.ensureSandbox(scope, { mounts: repoMounts() });
    expect(sbx.mounts?.map((m) => m.target)).toEqual(["/workspace/repo", "/workspace/repo/.git"]);
    const run = driver.find("run")[0]?.args ?? [];
    const flags = run.flatMap((a, i) => (run[i - 1] === "--mount" ? [a] : []));
    expect(flags[0]).toMatch(/^type=volume,source=psyche-ws-[0-9a-f]+,target=\/workspace$/);
    expect(flags.slice(1)).toEqual([
      `type=bind,source=${repo},target=/workspace/repo`,
      `type=bind,source=${repo}/.git,target=/workspace/repo/.git,readonly`,
    ]);
    // The same mounts in another order are the same sandbox; other mounts are a conflict.
    expect((await runner.ensureSandbox(scope, { mounts: repoMounts().reverse() })).id).toBe(sbx.id);
    expect(await code(runner.ensureSandbox(scope))).toBe("conflict");
    await runner.dispose();
  });

  it("builds Apple container mounts after the workspace volume", () => {
    const args = runArgs("apple-container", {
      name: "c",
      image: "i",
      volume: "v",
      network: "none",
      limits: { memoryMb: 512, cpus: 1, pids: 128, tmpMb: 64 },
      labels: {},
      env: {},
      mounts: [{ source: "/r", target: "/workspace/repo", readOnly: true }],
    });
    const at = args.indexOf("--mount");
    expect(args.slice(at - 2, at + 2)).toEqual([
      "--volume",
      "v:/workspace",
      "--mount",
      "type=bind,source=/r,target=/workspace/repo,readonly",
    ]);
  });
});
