import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_OWNER_LABEL,
  DESKTOP_SOCKET_TARGET,
  DesktopContainers,
  type DesktopSpec,
  desktopEnv,
  desktopNames,
  desktopRunArgs,
  resolveDesktopImage,
  sharesKey,
  validateDesktopMemory,
  validateDesktopShares,
} from "../src/desktop.ts";
import type { DetectDeps } from "../src/detect.ts";
import { FakeDriver } from "./fake-driver.ts";

const TOKEN = "t".repeat(43);
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-desk-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const spec = (over: Partial<DesktopSpec> = {}): DesktopSpec => ({
  id: "main",
  image: "psyche-sandbox:desktop-dev",
  socketPath: "/home/o/.psyche/run/guest-main.sock",
  token: TOKEN,
  shares: [],
  memory: "2g",
  ...over,
});

const fail = async (p: Promise<unknown>): Promise<PsycheError> => {
  try {
    await p;
  } catch (e) {
    return e as PsycheError;
  }
  throw new Error("expected a refusal");
};

describe("the desktop container's flags", () => {
  const args = desktopRunArgs("podman", spec());
  const has = (...flags: string[]) => {
    for (const f of flags) expect(args).toContain(f);
  };

  it("keeps the sandbox rules: read-only root, no capabilities, no network, no new privileges", () => {
    has(
      "--read-only",
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--network=none",
      "--detach",
      "--pull=never",
    );
    expect(args).toContain("--userns=keep-id:uid=1000,gid=1000");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args).toContain("--memory=2g");
    expect(args).toContain("--memory-swap=2g");
    expect(args.some((a) => a.startsWith("/tmp:rw,nosuid,nodev,size="))).toBe(true);
  });

  it("never asks for anything wider", () => {
    const joined = args.join(" ");
    expect(joined).not.toMatch(/--privileged|--network=host|--net=host|--cap-add|--pid=host|--ipc=host|--userns=host/);
    expect(joined).not.toMatch(/--device|--security-opt[= ]seccomp=unconfined|--security-opt[= ]label=disable/);
    expect(joined).not.toMatch(/docker\.sock|podman\.sock|XDG_RUNTIME/);
    // The only network flag is `none`.
    expect(args.filter((a) => a.startsWith("--network") || a.startsWith("--net"))).toEqual(["--network=none"]);
  });

  it("is labelled as ours, and mounts only the workspace volume and the one socket", () => {
    expect(args).toContain(`${DESKTOP_OWNER_LABEL}=1`);
    const mounts = args.filter((_, i) => args[i - 1] === "--mount");
    expect(mounts).toEqual([
      "type=volume,source=psyche-desktop-main-workspace,target=/workspace",
      `type=bind,source=/home/o/.psyche/run/guest-main.sock,target=${DESKTOP_SOCKET_TARGET},readonly`,
    ]);
  });

  it("puts only the names of environment variables on the command line, never the token", () => {
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args).toContain("PSYCHE_GUEST_TOKEN");
    expect(desktopEnv(TOKEN).PSYCHE_GUEST_TOKEN).toBe(TOKEN);
  });

  it("shares are read-only unless the share says otherwise, and are not executable or setuid on Podman", () => {
    const a = desktopRunArgs(
      "podman",
      spec({
        shares: [
          { source: "/data/a", name: "a", readOnly: true },
          { source: "/data/b", name: "b", readOnly: false },
        ],
      }),
    );
    const mounts = a.filter((_, i) => a[i - 1] === "--mount");
    expect(mounts).toContain("type=bind,source=/data/a,target=/shares/a,nosuid,nodev,noexec,readonly");
    expect(mounts).toContain("type=bind,source=/data/b,target=/shares/b,nosuid,nodev,noexec");
  });

  it("Docker gets the same rules without the Podman-only flags", () => {
    const d = desktopRunArgs("docker", spec({ shares: [{ source: "/data/a", name: "a", readOnly: true }] }));
    expect(d.some((a) => a.startsWith("--userns"))).toBe(false);
    expect(d).toContain("--read-only");
    expect(d).toContain("--network=none");
    expect(d).toContain("type=bind,source=/data/a,target=/shares/a,readonly");
  });

  it("refuses a socket path or name that could add mount options", () => {
    expect(() => desktopRunArgs("podman", spec({ socketPath: "/a,source=/etc/shadow" }))).toThrow(/not allowed/);
    expect(() => desktopRunArgs("podman", spec({ socketPath: "rel.sock" }))).toThrow(/not allowed/);
    expect(() => desktopNames("../x")).toThrow(/lowercase/);
    expect(() => desktopNames("A")).toThrow(/lowercase/);
  });

  it("the share list is part of the container's identity", () => {
    const one = [{ source: "/d/a", name: "a", readOnly: true }];
    expect(sharesKey(one)).toBe(sharesKey([...one]));
    expect(sharesKey(one)).not.toBe(sharesKey([{ ...one[0]!, readOnly: false }]));
    expect(sharesKey([])).not.toBe(sharesKey(one));
  });
});

describe("memory", () => {
  it("defaults to 2g and refuses anything outside 512m to 16g or not of the form 2g / 1536m", () => {
    expect(validateDesktopMemory(undefined)).toBe("2g");
    expect(validateDesktopMemory("1536m")).toBe("1536m");
    for (const bad of ["0", "256m", "17g", "2G", "2gb", "-1g", "2g --privileged", " 2g", "1e3m"]) {
      expect(() => validateDesktopMemory(bad), bad).toThrow(PsycheError);
    }
  });
});

describe("what may be shared", () => {
  const home = "/home/owner";
  const share = (source: string, name = "x") => [{ source, name, readOnly: true }];

  it("refuses the filesystem root, the home folder, and any ancestor of it", async () => {
    for (const p of ["/", "/home", home]) {
      expect((await fail(validateDesktopShares(share(p), { home }))).code, p).toBe("forbidden");
    }
  });

  it("refuses credential stores, configuration, the Gateway's home and system folders", async () => {
    const real = tmp();
    mkdirSync(join(real, ".psyche", "x"), { recursive: true });
    const roots = [`${home}/.ssh`, `${home}/.gnupg`, `${home}/.config`, `${home}/.config/gh`, `${home}/.local/share/containers`, `${home}/.psyche`, "/proc", "/sys", "/dev", "/run/user/1000", "/etc", "/root", "/var/lib/docker", "/tmp", "/usr"];
    for (const p of roots) {
      expect((await fail(validateDesktopShares(share(p), { home }))).code, p).toBe("forbidden");
    }
    // The Gateway's own protected roots, and anything that contains one.
    const protectedRoot = join(real, ".psyche");
    expect((await fail(validateDesktopShares(share(join(protectedRoot, "x")), { home, protectedRoots: [protectedRoot] }))).code).toBe("forbidden");
    expect((await fail(validateDesktopShares(share(real), { home, protectedRoots: [protectedRoot] }))).code).toBe("forbidden");
  });

  it("refuses a path that goes through a symlink, a missing folder and a path that could add mount options", async () => {
    const real = tmp();
    mkdirSync(join(real, "docs"));
    symlinkSync(join(real, "docs"), join(real, "link"));
    expect((await fail(validateDesktopShares(share(join(real, "link")), { home }))).message).toMatch(/symlink/);
    expect((await fail(validateDesktopShares(share(join(real, "nope")), { home }))).code).toBe("not_found");
    for (const bad of [`${real}/docs,source=/etc`, `${real}/a=b`, `${real}/docs/`, `${real}/../${real}/docs`, "relative/dir"]) {
      expect((await fail(validateDesktopShares(share(bad), { home }))).code, bad).toBe("forbidden");
    }
  });

  it("refuses duplicate or odd names, and more than eight shares", async () => {
    const real = tmp();
    mkdirSync(join(real, "a"));
    const s = (name: string) => ({ source: join(real, "a"), name, readOnly: true });
    expect((await fail(validateDesktopShares([s("one"), s("one")], { home }))).code).toBe("invalid_params");
    for (const bad of ["", ".hidden", "a/b", "a,b", "a b", "x".repeat(65)]) {
      expect((await fail(validateDesktopShares([s(bad)], { home }))).code, bad).toBe("invalid_params");
    }
    const many = Array.from({ length: 9 }, (_, i) => s(`n${i}`));
    expect((await fail(validateDesktopShares(many, { home }))).code).toBe("invalid_params");
  });

  it("accepts an ordinary folder and returns it by name", async () => {
    const real = tmp();
    mkdirSync(join(real, "proj"));
    const out = await validateDesktopShares([{ source: join(real, "proj"), name: "proj", readOnly: false }], { home });
    expect(out).toEqual([{ source: join(real, "proj"), name: "proj", readOnly: false }]);
  });
});

function engine(opts: { podman?: boolean; docker?: boolean; podmanRootless?: boolean; dockerRootless?: boolean; apple?: boolean }): DetectDeps {
  const have = new Set<string>();
  if (opts.podman) have.add("podman");
  if (opts.docker) have.add("docker");
  if (opts.apple) have.add("container");
  return {
    platform: "linux",
    arch: "x64",
    env: {},
    async which(c) {
      return have.has(c) ? `/usr/bin/${c}` : null;
    },
    async macosVersion() {
      return null;
    },
    async probe(cli, args) {
      if (args[0] === "info" && args[2]?.includes("Rootless")) return opts.podmanRootless === false ? "false" : "true";
      if (args[0] === "info" && args[2]?.includes("SecurityOptions")) return opts.dockerRootless ? "[name=seccomp,profile=builtin name=rootless]" : "[name=seccomp,profile=builtin]";
      if (cli.endsWith("podman")) return "4.9.3";
      if (cli.endsWith("docker")) return "27.0.0";
      return "1.0";
    },
  };
}

describe("choosing the engine", () => {
  it("prefers Podman over Docker, and says whether it is rootless", async () => {
    const d = new DesktopContainers({ detectDeps: engine({ podman: true, docker: true, dockerRootless: true }) });
    expect(await d.backend()).toMatchObject({ kind: "podman", rootless: true });
  });

  it("uses Docker when there is no Podman, and marks a rootful one", async () => {
    const rootful = new DesktopContainers({ detectDeps: engine({ docker: true }) });
    expect(await rootful.backend()).toMatchObject({ kind: "docker", rootless: false });
    const rootless = new DesktopContainers({ detectDeps: engine({ docker: true, dockerRootless: true }) });
    expect(await rootless.backend()).toMatchObject({ kind: "docker", rootless: true });
  });

  it("marks a rootful Podman too", async () => {
    const d = new DesktopContainers({ detectDeps: engine({ podman: true, podmanRootless: false }) });
    expect((await d.backend())?.rootless).toBe(false);
  });

  it("never uses Apple container, and with no engine says what to install and runs nothing", async () => {
    const driver = new FakeDriver();
    const d = new DesktopContainers({ driver, detectDeps: engine({ apple: true }) });
    expect(await d.backend()).toBeUndefined();
    const err = await fail(d.start({ id: "main", socketPath: "/s.sock", token: TOKEN }));
    expect(err.code).toBe("unavailable");
    expect(err.message).toMatch(/Podman/);
    expect(driver.calls).toEqual([]);
  });
});

describe("the lifecycle, against a fake Podman", () => {
  const sockDir = () => tmp();

  function setup(respond?: (args: string[]) => { exitCode?: number; stdout?: Buffer; stderr?: Buffer } | undefined) {
    const driver = new FakeDriver();
    let running = false;
    driver.respond = (args) => {
      const custom = respond?.(args);
      if (custom !== undefined) return custom;
      if (args[0] === "image" && args[1] === "inspect") return { stdout: Buffer.from("1234567890\n") };
      if (args[0] === "inspect") {
        return running
          ? { stdout: Buffer.from(JSON.stringify([{ State: { Running: true }, Config: { Labels: { "com.psyche.shares": "abc" } } }])) }
          : { exitCode: 1, stderr: Buffer.from("no such container") };
      }
      if (args[0] === "run") running = true;
      if (args[0] === "rm" || args[0] === "stop") running = false;
      return undefined;
    };
    const d = new DesktopContainers({
      driver,
      detectDeps: engine({ podman: true }),
      image: "psyche-sandbox:desktop-dev",
      home: "/home/owner",
    });
    return { d, driver };
  }

  it("starts: clears an old container, creates the workspace volume, runs, then checks it is up", async () => {
    const { d, driver } = setup();
    const out = await d.start({ id: "main", socketPath: join(sockDir(), "g.sock"), token: TOKEN });
    expect(out.container).toBe("psyche-desktop-main");
    const verbs = driver.calls.map((c) => c.args[0]);
    expect(verbs.indexOf("rm")).toBeLessThan(verbs.indexOf("volume"));
    expect(verbs.indexOf("volume")).toBeLessThan(verbs.indexOf("run"));
    expect(verbs.lastIndexOf("inspect")).toBeGreaterThan(verbs.indexOf("run"));
    const run = driver.calls.find((c) => c.args[0] === "run");
    expect(run?.args).toContain("--network=none");
    // The token reaches the engine's process environment only.
    expect(run?.options.env?.PSYCHE_GUEST_TOKEN).toBe(TOKEN);
    expect(driver.calls.some((c) => c.args.join(" ").includes(TOKEN))).toBe(false);
    expect(driver.calls.every((c) => c.file === "/usr/bin/podman")).toBe(true);
  });

  it("removes the container and fails when it did not come up", async () => {
    const { d, driver } = setup((args) => (args[0] === "run" ? { exitCode: 125, stderr: Buffer.from("boom") } : undefined));
    const err = await fail(d.start({ id: "main", socketPath: "/s.sock", token: TOKEN }));
    expect(err.code).toBe("unavailable");
    expect(err.details).toMatchObject({ reason: "start_failed" });
    expect(driver.calls.at(-1)?.args.slice(0, 3)).toEqual(["rm", "--force", "psyche-desktop-main"]);
  });

  it("refuses a short token and a share that is not allowed, before running anything", async () => {
    const { d, driver } = setup();
    expect((await fail(d.start({ id: "main", socketPath: "/s.sock", token: "short" }))).code).toBe("invalid_params");
    expect(
      (await fail(d.start({ id: "main", socketPath: "/s.sock", token: TOKEN, shares: [{ source: "/home/owner", name: "h", readOnly: true }] }))).code,
    ).toBe("forbidden");
    expect(driver.find("run")).toEqual([]);
  });

  it("refuses to run a missing local image, and says how to build it", async () => {
    const { d, driver } = setup((args) => (args[0] === "image" ? { exitCode: 1 } : undefined));
    const err = await fail(d.start({ id: "main", socketPath: "/s.sock", token: TOKEN }));
    expect(err.details).toMatchObject({ reason: "image_missing" });
    expect(err.message).toMatch(/deploy\/sandbox-image/);
    expect(driver.find("run")).toEqual([]);
    expect(driver.find("pull")).toEqual([]);
  });

  it("stop removes the container and keeps the workspace", async () => {
    const { d, driver } = setup();
    await d.stop("main");
    expect(driver.find("stop")).toHaveLength(1);
    expect(driver.find("rm", "--force", "psyche-desktop-main")).toHaveLength(1);
    expect(driver.find("volume")).toEqual([]);
  });

  it("reset removes the container and the workspace volume", async () => {
    const { d, driver } = setup();
    await d.reset("main");
    expect(driver.find("rm", "--force", "psyche-desktop-main")).toHaveLength(1);
    expect(driver.find("volume", "rm", "--force", "psyche-desktop-main-workspace")).toHaveLength(1);
  });

  it("reconcile removes only our own labelled desktops, by name", async () => {
    const { d, driver } = setup((args) =>
      args[0] === "ps" ? { stdout: Buffer.from("psyche-desktop-main\nsomeones-container\npsyche-desktop-../x\n") } : undefined,
    );
    expect(await d.reconcile()).toEqual(["main"]);
    expect(driver.find("ps")[0]?.args).toContain(`label=${DESKTOP_OWNER_LABEL}=1`);
    expect(driver.find("rm").map((c) => c.args[2])).toEqual(["psyche-desktop-main"]);
  });

  it("internet is only the egress shim over stdio: no network is ever added", async () => {
    const { d, driver } = setup();
    const seen: unknown[] = [];
    const pending = d.openEgress("main", { kind: "task", id: "t1" }, { handle: (scope) => void seen.push(scope) });
    await vi.waitFor(() => expect(driver.streams).toHaveLength(1));
    const stream = driver.streams[0];
    expect(stream?.args.slice(0, 5)).toEqual(["exec", "--interactive", "--user", "1000:1000", "--workdir"]);
    expect(stream?.args).toContain("psyche-desktop-main");
    expect(stream?.args.join(" ")).not.toMatch(/--network|--publish|-p /);
    stream?.exit(1);
    await expect(pending).rejects.toThrow(/internet connection did not start/);
    expect(driver.calls.some((c) => c.args.includes("network") && c.args[0] === "network")).toBe(false);
  });
});

describe("the image", () => {
  it("is the local dev tag until a release pins a digest, and the owner's override wins", () => {
    expect(resolveDesktopImage(undefined, {})).toEqual({ image: "psyche-sandbox:desktop-dev", pinned: false });
    expect(resolveDesktopImage("x:y", {})).toEqual({ image: "x:y", pinned: false });
    expect(resolveDesktopImage(undefined, { PSYCHE_SANDBOX_IMAGE: "z:1" })).toEqual({ image: "z:1", pinned: false });
  });
});
