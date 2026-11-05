import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_OWNER_LABEL,
  DESKTOP_SOCKET_TARGET,
  DESKTOP_TOKEN_TARGET,
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
  tokenPath: "/home/o/.psyche/run/guest-main.token",
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
    expect(joined).not.toMatch(
      /--privileged|--network=host|--net=host|--cap-add|--pid=host|--ipc=host|--userns=host/,
    );
    expect(joined).not.toMatch(
      /--device|--security-opt[= ]seccomp=unconfined|--security-opt[= ]label=disable/,
    );
    expect(joined).not.toMatch(/docker\.sock|podman\.sock|XDG_RUNTIME/);
    // The only network flag is `none`.
    expect(args.filter((a) => a.startsWith("--network") || a.startsWith("--net"))).toEqual([
      "--network=none",
    ]);
  });

  it("is labelled as ours, and mounts only the workspace (nothing in it runs), the socket and the token file", () => {
    expect(args).toContain(`${DESKTOP_OWNER_LABEL}=1`);
    const mounts = args.filter((_, i) => args[i - 1] === "--mount");
    expect(mounts).toEqual([
      "type=volume,source=psyche-desktop-main-workspace,target=/workspace,noexec,nosuid,nodev",
      `type=bind,source=/home/o/.psyche/run/guest-main.sock,target=${DESKTOP_SOCKET_TARGET},readonly`,
      `type=bind,source=/home/o/.psyche/run/guest-main.token,target=${DESKTOP_TOKEN_TARGET}`,
    ]);
  });

  it("sets HOME to the workspace: with a user namespace the engine would use the host user's", () => {
    const i = args.indexOf("HOME=/workspace");
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe("--env");
  });

  it("the token is never in the environment: the container gets only proxy settings", () => {
    expect(Object.keys(desktopEnv()).sort()).toEqual([
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]);
    expect(args.join(" ")).not.toMatch(/TOKEN/);
    expect(args.join(" ")).not.toContain(TOKEN);
    // Nor in a form that asks the engine to copy one from the Gateway's own environment.
    expect(args.filter((_, i) => args[i - 1] === "-e").every((n) => !/token|secret/i.test(n))).toBe(
      true,
    );
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
    expect(mounts).toContain(
      "type=bind,source=/data/a,target=/shares/a,nosuid,nodev,noexec,readonly",
    );
    expect(mounts).toContain("type=bind,source=/data/b,target=/shares/b,nosuid,nodev,noexec");
  });

  it("Docker's workspace volume takes no such options", () => {
    const d = desktopRunArgs("docker", spec());
    expect(d).toContain("type=volume,source=psyche-desktop-main-workspace,target=/workspace");
  });

  it("Docker gets the same rules without the Podman-only flags", () => {
    const d = desktopRunArgs(
      "docker",
      spec({ shares: [{ source: "/data/a", name: "a", readOnly: true }] }),
    );
    expect(d.some((a) => a.startsWith("--userns"))).toBe(false);
    expect(d).toContain("--read-only");
    expect(d).toContain("--network=none");
    expect(d).toContain("type=bind,source=/data/a,target=/shares/a,readonly");
  });

  it("refuses a socket path or name that could add mount options", () => {
    expect(() => desktopRunArgs("podman", spec({ socketPath: "/a,source=/etc/shadow" }))).toThrow(
      /not allowed/,
    );
    expect(() => desktopRunArgs("podman", spec({ socketPath: "rel.sock" }))).toThrow(/not allowed/);
    expect(() => desktopRunArgs("podman", spec({ tokenPath: "/t,source=/etc" }))).toThrow(
      /not allowed/,
    );
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
    const roots = [
      `${home}/.ssh`,
      `${home}/.gnupg`,
      `${home}/.config`,
      `${home}/.config/gh`,
      `${home}/.local/share/containers`,
      `${home}/.psyche`,
      "/proc",
      "/sys",
      "/dev",
      "/run/user/1000",
      "/etc",
      "/root",
      "/var/lib/docker",
      "/tmp",
      "/usr",
    ];
    for (const p of roots) {
      expect((await fail(validateDesktopShares(share(p), { home }))).code, p).toBe("forbidden");
    }
    // The Gateway's own protected roots, and anything that contains one.
    const protectedRoot = join(real, ".psyche");
    expect(
      (
        await fail(
          validateDesktopShares(share(join(protectedRoot, "x")), {
            home,
            protectedRoots: [protectedRoot],
          }),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (await fail(validateDesktopShares(share(real), { home, protectedRoots: [protectedRoot] })))
        .code,
    ).toBe("forbidden");
  });

  it("refuses a path that goes through a symlink, a missing folder and a path that could add mount options", async () => {
    const real = tmp();
    mkdirSync(join(real, "docs"));
    symlinkSync(join(real, "docs"), join(real, "link"));
    expect(
      (await fail(validateDesktopShares(share(join(real, "link")), { home }))).message,
    ).toMatch(/symlink/);
    expect((await fail(validateDesktopShares(share(join(real, "nope")), { home }))).code).toBe(
      "not_found",
    );
    for (const bad of [
      `${real}/docs,source=/etc`,
      `${real}/a=b`,
      `${real}/docs/`,
      `${real}/../${real}/docs`,
      "relative/dir",
    ]) {
      expect((await fail(validateDesktopShares(share(bad), { home }))).code, bad).toBe("forbidden");
    }
  });

  it("refuses duplicate or odd names, and more than eight shares", async () => {
    const real = tmp();
    mkdirSync(join(real, "a"));
    const s = (name: string) => ({ source: join(real, "a"), name, readOnly: true });
    expect((await fail(validateDesktopShares([s("one"), s("one")], { home }))).code).toBe(
      "invalid_params",
    );
    for (const bad of ["", ".hidden", "a/b", "a,b", "a b", "x".repeat(65)]) {
      expect((await fail(validateDesktopShares([s(bad)], { home }))).code, bad).toBe(
        "invalid_params",
      );
    }
    const many = Array.from({ length: 9 }, (_, i) => s(`n${i}`));
    expect((await fail(validateDesktopShares(many, { home }))).code).toBe("invalid_params");
  });

  it("refuses shell and tool setups, package stores and wallets under the home folder", async () => {
    for (const rel of [
      "snap",
      "snap/firefox/common",
      "bin",
      ".local",
      ".local/bin",
      ".local/share/keyrings",
      ".cargo",
      ".rustup",
      ".nvm",
      ".bun",
      ".deno",
      ".pyenv",
      "go",
      "go/pkg",
      ".vim",
      ".emacs.d",
      ".oh-my-zsh",
      ".bashrc.d",
      ".profile.d",
      ".m2",
      ".gradle",
      ".terraform.d",
      ".bitcoin",
      ".ethereum",
      ".electrum",
    ]) {
      expect((await fail(validateDesktopShares(share(`${home}/${rel}`), { home }))).code, rel).toBe(
        "forbidden",
      );
    }
  });

  const rwShare = (source: string) => [{ source, name: "x", readOnly: false }];
  const gitRefused = async (source: string) => {
    const err = await fail(validateDesktopShares(rwShare(source), { home }));
    expect(err.code).toBe("forbidden");
    expect(err.details).toMatchObject({ reason: "git_in_read_write_share" });
  };

  it("refuses a read-write share with a git repository anywhere in it, however deep", async () => {
    const root = tmp();
    mkdirSync(join(root, "top", ".git"), { recursive: true });
    await gitRefused(join(root, "top"));
    // Far below any depth a shallow search would reach.
    const deep = join(root, "deep", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
    mkdirSync(join(deep, ".git"), { recursive: true });
    await gitRefused(join(root, "deep"));
    // A `.git` file: a worktree or a submodule.
    mkdirSync(join(root, "wt", "sub"), { recursive: true });
    writeFileSync(join(root, "wt", "sub", ".git"), "gitdir: ../elsewhere");
    await gitRefused(join(root, "wt"));
  });

  it("refuses a bare repository (HEAD, objects/ and refs/) and a .git that is a link", async () => {
    const root = tmp();
    mkdirSync(join(root, "bare", "r.git", "objects"), { recursive: true });
    mkdirSync(join(root, "bare", "r.git", "refs"));
    writeFileSync(join(root, "bare", "r.git", "HEAD"), "ref: refs/heads/main");
    await gitRefused(join(root, "bare"));
    mkdirSync(join(root, "link"));
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "link", ".git"));
    await gitRefused(join(root, "link"));
    // Not a repository: a folder that merely has a file called HEAD.
    mkdirSync(join(root, "fine"));
    writeFileSync(join(root, "fine", "HEAD"), "x");
    expect(await validateDesktopShares(rwShare(join(root, "fine")), { home })).toHaveLength(1);
  });

  it("refuses a read-write share it cannot search, or that is too large to search", async () => {
    const root = tmp();
    mkdirSync(join(root, "locked", "inner"), { recursive: true });
    chmodSync(join(root, "locked", "inner"), 0o000);
    try {
      // Running as root can read anything: only assert where the folder really is unreadable.
      if (process.getuid?.() !== 0) await gitRefused(join(root, "locked"));
    } finally {
      chmodSync(join(root, "locked", "inner"), 0o755);
    }
    mkdirSync(join(root, "big"));
    for (let i = 0; i < 50_001; i++) writeFileSync(join(root, "big", `f${i}`), "");
    const err = await fail(validateDesktopShares(rwShare(join(root, "big")), { home }));
    expect(err.message).toMatch(/too large to check for git data/);
  }, 60_000);

  it("refuses a read-write share inside a git repository, any parent up to the home folder", async () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    const err = await fail(
      validateDesktopShares([{ source: join(root, "a", "b", "c"), name: "c", readOnly: false }], {
        home: root,
      }),
    );
    expect(err.details).toMatchObject({ reason: "git_in_read_write_share" });
    expect(err.message).toMatch(/inside a git repository/);
    // Read-only is fine, and so is a folder whose parents hold no repository.
    const ro = await validateDesktopShares(
      [{ source: join(root, "a", "b", "c"), name: "c", readOnly: true }],
      { home: root },
    );
    expect(ro).toHaveLength(1);
    const clean = tmp();
    mkdirSync(join(clean, "x", "y"), { recursive: true });
    const ok = await validateDesktopShares(
      [{ source: join(clean, "x", "y"), name: "y", readOnly: false }],
      { home: clean },
    );
    expect(ok).toHaveLength(1);
    // A bare repository as a parent counts too.
    const bare = tmp();
    mkdirSync(join(bare, "objects"));
    mkdirSync(join(bare, "refs"));
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main");
    mkdirSync(join(bare, "work"));
    expect(
      (
        await fail(
          validateDesktopShares([{ source: join(bare, "work"), name: "w", readOnly: false }], {
            home: bare,
          }),
        )
      ).details,
    ).toMatchObject({ reason: "git_in_read_write_share" });
  });

  it("a repository can still be shared read-only; a folder with no git can be read-write", async () => {
    const root = tmp();
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    const ro = await validateDesktopShares(
      [{ source: join(root, "repo"), name: "repo", readOnly: true }],
      { home },
    );
    expect(ro[0]).toMatchObject({ readOnly: true });
    mkdirSync(join(root, "plain", "docs"), { recursive: true });
    writeFileSync(join(root, "plain", "docs", "a.txt"), "x");
    const rw = await validateDesktopShares(rwShare(join(root, "plain")), { home });
    expect(rw[0]).toMatchObject({ readOnly: false });
    // Never an overlay: nothing is mounted on top of a share.
    const args = desktopRunArgs("podman", spec({ shares: rw }));
    expect(
      args.filter((_, i) => args[i - 1] === "--mount").filter((m) => m.includes("target=/shares/")),
    ).toHaveLength(1);
  });

  it("accepts an ordinary folder and returns it by name", async () => {
    const real = tmp();
    mkdirSync(join(real, "proj"));
    const out = await validateDesktopShares(
      [{ source: join(real, "proj"), name: "proj", readOnly: false }],
      { home },
    );
    expect(out).toMatchObject([{ source: join(real, "proj"), name: "proj", readOnly: false }]);
    expect(out[0]?.identity?.ino).toMatch(/^[0-9]+$/);
  });
});

function engine(opts: {
  podman?: boolean;
  docker?: boolean;
  podmanRootless?: boolean;
  dockerRootless?: boolean;
  apple?: boolean;
}): DetectDeps {
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
      if (args[0] === "info" && args[2]?.includes("Rootless"))
        return opts.podmanRootless === false ? "false" : "true";
      if (args[0] === "info" && args[2]?.includes("SecurityOptions"))
        return opts.dockerRootless
          ? "[name=seccomp,profile=builtin name=rootless]"
          : "[name=seccomp,profile=builtin]";
      if (cli.endsWith("podman")) return "4.9.3";
      if (cli.endsWith("docker")) return "27.0.0";
      return "1.0";
    },
  };
}

describe("choosing the engine", () => {
  it("prefers Podman over Docker, and says whether it is rootless", async () => {
    const d = new DesktopContainers({
      detectDeps: engine({ podman: true, docker: true, dockerRootless: true }),
    });
    expect(await d.backend()).toMatchObject({ kind: "podman", rootless: true });
  });

  it("uses Docker when there is no Podman, and marks a rootful one", async () => {
    const rootful = new DesktopContainers({ detectDeps: engine({ docker: true }) });
    expect(await rootful.backend()).toMatchObject({ kind: "docker", rootless: false });
    const rootless = new DesktopContainers({
      detectDeps: engine({ docker: true, dockerRootless: true }),
    });
    expect(await rootless.backend()).toMatchObject({ kind: "docker", rootless: true });
  });

  it("marks a rootful Podman too", async () => {
    const d = new DesktopContainers({
      detectDeps: engine({ podman: true, podmanRootless: false }),
    });
    expect((await d.backend())?.rootless).toBe(false);
  });

  it("never uses Apple container, and with no engine says what to install and runs nothing", async () => {
    const driver = new FakeDriver();
    const d = new DesktopContainers({ driver, detectDeps: engine({ apple: true }) });
    expect(await d.backend()).toBeUndefined();
    const err = await fail(d.start({ id: "main", socketPath: "/s.sock", tokenPath: "/t" }));
    expect(err.code).toBe("unavailable");
    expect(err.message).toMatch(/Podman/);
    expect(driver.calls).toEqual([]);
  });
});

describe("the lifecycle, against a fake Podman", () => {
  /** Real files standing in for the socket and the token, so their identities can be recorded. */
  const files = () => {
    const dir = tmp();
    const socketPath = join(dir, "g.sock");
    const tokenPath = join(dir, "g.token");
    writeFileSync(socketPath, "");
    writeFileSync(tokenPath, `${TOKEN}\n`);
    return { socketPath, tokenPath };
  };
  const req = (over: Record<string, unknown> = {}) => ({ id: "main", ...files(), ...over });

  interface Mount {
    Type: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }
  /** The mounts a real engine would report for a `run`: read back from its own arguments. */
  const mountsOf = (run: string[]): Mount[] =>
    run
      .filter((_, i) => run[i - 1] === "--mount")
      .map((m) => {
        const f = Object.fromEntries(m.split(",").map((kv) => kv.split("=") as [string, string]));
        return {
          Type: f.type ?? "",
          Source: f.source ?? "",
          Destination: f.target ?? "",
          RW: !m.split(",").includes("readonly"),
        };
      })
      .map((m) => (m.Type === "volume" ? { ...m, Source: "/vol/_data" } : m));

  interface Tamper {
    mounts?: (m: Mount[]) => Mount[];
    /** What the host sees under /proc/<pid>/root for a destination (default: the validated file). */
    seen?: (dest: string, source: string) => string | undefined;
    /** Per-mount options in the made-up mountinfo. */
    options?: (m: Mount) => string | undefined;
    memoryMax?: string;
    pidsMax?: string;
    noMountinfo?: boolean;
    pid?: string;
  }

  function setup(
    respond?: (
      args: string[],
    ) => { exitCode?: number; stdout?: Buffer; stderr?: Buffer } | undefined,
    t: Tamper = {},
  ) {
    const driver = new FakeDriver();
    const procRoot = tmp();
    const cgroupRoot = tmp();
    let running = false;
    let lastRun: string[] = [];
    /** The host's view of the container's main process: /proc/<pid>/{root,mountinfo,cgroup}. */
    const buildProc = () => {
      const pid = t.pid ?? "4242";
      const root = join(procRoot, pid);
      mkdirSync(join(root, "root"), { recursive: true });
      const lines: string[] = [];
      for (const m of mountsOf(lastRun).filter((x) => x.Type === "bind")) {
        const shown = t.seen ? t.seen(m.Destination, m.Source) : m.Source;
        if (shown !== undefined) {
          mkdirSync(join(root, "root", m.Destination, ".."), { recursive: true });
          symlinkSync(shown, join(root, "root", m.Destination));
        }
        const opts = t.options ? t.options(m) : `${m.RW ? "rw" : "ro"},nosuid,nodev,noexec`;
        if (opts !== undefined) {
          lines.push(`${lines.length + 1} 1 0:5 / ${m.Destination} ${opts} - bind src rw`);
        }
      }
      if (!t.noMountinfo) writeFileSync(join(root, "mountinfo"), `${lines.join("\n")}\n`);
      writeFileSync(join(root, "cgroup"), "0::/user.slice/libpod-test.scope\n");
      const cg = join(cgroupRoot, "user.slice", "libpod-test.scope");
      mkdirSync(cg, { recursive: true });
      writeFileSync(join(cg, "memory.max"), `${t.memoryMax ?? "2147483648"}\n`);
      writeFileSync(join(cg, "pids.max"), `${t.pidsMax ?? "1024"}\n`);
    };
    driver.respond = (args) => {
      const custom = respond?.(args);
      if (custom !== undefined) return custom;
      if (args[0] === "image" && args[1] === "inspect")
        return { stdout: Buffer.from("1234567890\n") };
      if (args[0] === "inspect" && args[2] === "{{json .Mounts}}") {
        const mounts = t.mounts ?? ((m: Mount[]) => m);
        return { stdout: Buffer.from(JSON.stringify(mounts(mountsOf(lastRun)))) };
      }
      if (args[0] === "inspect" && args[2] === "{{.State.Pid}}") {
        return { stdout: Buffer.from(`${t.pid ?? "4242"}\n`) };
      }
      if (args[0] === "inspect") {
        return running
          ? {
              stdout: Buffer.from(
                JSON.stringify([
                  { State: { Running: true }, Config: { Labels: { "com.psyche.shares": "abc" } } },
                ]),
              ),
            }
          : { exitCode: 1, stderr: Buffer.from("no such container") };
      }
      if (args[0] === "run") {
        running = true;
        lastRun = args;
        buildProc();
      }
      if (args[0] === "rm" || args[0] === "stop") running = false;
      return undefined;
    };
    const d = new DesktopContainers({
      driver,
      detectDeps: engine({ podman: true }),
      image: "psyche-sandbox:desktop-dev",
      home: "/home/owner",
      procRoot,
      cgroupRoot,
    });
    return { d, driver };
  }

  it("starts: clears an old container, creates the workspace volume, runs, then checks it is up", async () => {
    const { d, driver } = setup();
    const out = await d.start(req());
    expect(out.container).toBe("psyche-desktop-main");
    expect(out.limits).toEqual({ memory: true, pids: true });
    const verbs = driver.calls.map((c) => c.args[0]);
    expect(verbs.indexOf("rm")).toBeLessThan(verbs.indexOf("volume"));
    expect(verbs.indexOf("volume")).toBeLessThan(verbs.indexOf("run"));
    expect(verbs.lastIndexOf("inspect")).toBeGreaterThan(verbs.indexOf("run"));
    // The workspace survives every start, so creating it again must not fail on Podman.
    expect(driver.find("volume", "create")[0]?.args).toContain("--ignore");
    const run = driver.calls.find((c) => c.args[0] === "run");
    expect(run?.args).toContain("--network=none");
    expect(driver.calls.every((c) => c.file === "/usr/bin/podman")).toBe(true);
  });

  it("the token appears nowhere the engine, its arguments or its environment could show it", async () => {
    const { d, driver } = setup();
    await d.start(req());
    const run = driver.calls.find((c) => c.args[0] === "run");
    expect(run?.options.env?.PSYCHE_GUEST_TOKEN).toBeUndefined();
    expect(Object.values(run?.options.env ?? {}).includes(TOKEN)).toBe(false);
    expect(driver.calls.some((c) => c.args.join(" ").includes(TOKEN))).toBe(false);
    // `podman inspect` (Config.Env included) is asked for the mounts and the pid only.
    expect(
      driver.find("inspect").every((c) => c.args.includes("--format") || c.args.length === 2),
    ).toBe(true);
  });

  it("asks the container nothing to verify itself: no exec, so no program in its workspace is involved", async () => {
    const { d, driver } = setup();
    await d.start(req());
    expect(driver.find("exec")).toEqual([]);
    expect(driver.streams).toEqual([]);
  });

  it("removes the container and fails when it did not come up", async () => {
    const { d, driver } = setup((args) =>
      args[0] === "run" ? { exitCode: 125, stderr: Buffer.from("boom") } : undefined,
    );
    const err = await fail(d.start(req()));
    expect(err.code).toBe("unavailable");
    expect(err.details).toMatchObject({ reason: "start_failed" });
    expect(driver.calls.at(-1)?.args.slice(0, 3)).toEqual(["rm", "--force", "psyche-desktop-main"]);
  });

  it("refuses a share that is not allowed, before running anything", async () => {
    const { d, driver } = setup();
    expect(
      (await fail(d.start(req({ shares: [{ source: "/home/owner", name: "h", readOnly: true }] }))))
        .code,
    ).toBe("forbidden");
    expect(driver.find("run")).toEqual([]);
  });

  it("refuses to run a missing local image, and says how to build it", async () => {
    const { d, driver } = setup((args) => (args[0] === "image" ? { exitCode: 1 } : undefined));
    const err = await fail(d.start(req()));
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
      args[0] === "ps"
        ? { stdout: Buffer.from("psyche-desktop-main\nsomeones-container\npsyche-desktop-../x\n") }
        : undefined,
    );
    expect(await d.reconcile()).toEqual(["main"]);
    expect(driver.find("ps")[0]?.args).toContain(`label=${DESKTOP_OWNER_LABEL}=1`);
    expect(driver.find("rm").map((c) => c.args[2])).toEqual(["psyche-desktop-main"]);
  });

  const two = () => {
    const root = tmp();
    mkdirSync(join(root, "ro"));
    mkdirSync(join(root, "rw"));
    mkdirSync(join(root, "other"));
    return {
      root,
      shares: [
        { source: join(root, "ro"), name: "ro", readOnly: true },
        { source: join(root, "rw"), name: "rw", readOnly: false },
      ],
    };
  };

  it("accepts the mounts that were approved, checked from the host through /proc/<pid>", async () => {
    const { shares } = two();
    const { d } = setup();
    const out = await d.start(req({ shares }));
    expect(out.container).toBe("psyche-desktop-main");
  });

  it("tears the container down when the engine reports other mounts than were checked", async () => {
    const { root, shares } = two();
    const cases: [string, (m: Mount[]) => Mount[]][] = [
      [
        "a path swapped for another folder",
        (m) =>
          m.map((x) =>
            x.Destination === "/shares/ro" ? { ...x, Source: join(root, "other") } : x,
          ),
      ],
      [
        "an extra bind mount",
        (m) => [...m, { Type: "bind", Source: "/", Destination: "/host", RW: false }],
      ],
      ["a missing share", (m) => m.filter((x) => x.Destination !== "/shares/ro")],
      [
        "a read-only share that came up writable",
        (m) => m.map((x) => (x.Destination === "/shares/ro" ? { ...x, RW: true } : x)),
      ],
      [
        "the token file from somewhere else",
        (m) =>
          m.map((x) =>
            x.Destination === "/run/psyche/token" ? { ...x, Source: join(root, "other") } : x,
          ),
      ],
    ];
    for (const [name, mounts] of cases) {
      const { d, driver } = setup(undefined, { mounts });
      const err = await fail(d.start(req({ shares })));
      expect(err.details, name).toMatchObject({ reason: "mount_mismatch" });
      expect(driver.calls.at(-1)?.args.slice(0, 3), name).toEqual([
        "rm",
        "--force",
        "psyche-desktop-main",
      ]);
    }
  });

  it("tears the container down when the host's own view of the container differs", async () => {
    const { root, shares } = two();
    const cases: [string, Tamper][] = [
      [
        "a share that is another folder under /proc/<pid>/root",
        { seen: (d, s) => (d === "/shares/ro" ? join(root, "other") : s) },
      ],
      [
        "the socket that is another file",
        { seen: (d, s) => (d.endsWith(".sock") ? join(root, "other") : s) },
      ],
      [
        "a share missing under /proc/<pid>/root",
        { seen: (d, s) => (d === "/shares/rw" ? undefined : s) },
      ],
      [
        "a read-only share mounted read-write",
        { options: (m) => (m.Destination === "/shares/ro" ? "rw" : m.RW ? "rw" : "ro") },
      ],
      [
        "a read-write share mounted read-only",
        { options: (m) => (m.Destination === "/shares/rw" ? "ro" : m.RW ? "rw" : "ro") },
      ],
      [
        "a mount missing from the mount table",
        { options: (m) => (m.Destination === "/shares/rw" ? undefined : m.RW ? "rw" : "ro") },
      ],
      ["a mount table that can't be read", { noMountinfo: true }],
      ["a container with no process", { pid: "0" }],
    ];
    for (const [name, t] of cases) {
      const { d, driver } = setup(undefined, t);
      const err = await fail(d.start(req({ shares })));
      expect(err.details, name).toMatchObject({ reason: "mount_mismatch" });
      expect(driver.calls.at(-1)?.args.slice(0, 3), name).toEqual([
        "rm",
        "--force",
        "psyche-desktop-main",
      ]);
    }
  });

  it("reports limits the system does not enforce, and still runs", async () => {
    for (const [t, want] of [
      [
        { memoryMax: "max", pidsMax: "max" },
        { memory: false, pids: false },
      ],
      [{ pidsMax: "max" }, { memory: true, pids: false }],
      [{ memoryMax: "1073741824" }, { memory: false, pids: true }],
    ] as const) {
      const { d } = setup(undefined, t);
      const out = await d.start(req());
      expect(out.limits, JSON.stringify(t)).toEqual(want);
    }
  });

  it("internet is only the egress shim over stdio: no network is ever added", async () => {
    const { d, driver } = setup();
    const seen: unknown[] = [];
    const pending = d.openEgress(
      "main",
      { kind: "task", id: "t1" },
      { handle: (scope) => void seen.push(scope) },
    );
    await vi.waitFor(() => expect(driver.streams).toHaveLength(1));
    const stream = driver.streams[0];
    expect(stream?.args.slice(0, 5)).toEqual([
      "exec",
      "--interactive",
      "--user",
      "1000:1000",
      "--workdir",
    ]);
    // A clean PATH and an absolute interpreter: nothing the container can write is looked at.
    expect(stream?.args).toContain("PATH=/usr/bin:/bin");
    expect(stream?.args).toContain("/usr/bin/python3");
    expect(stream?.args).toContain("psyche-desktop-main");
    expect(stream?.args.join(" ")).not.toMatch(/--network|--publish|-p /);
    stream?.exit(1);
    await expect(pending).rejects.toThrow(/internet connection did not start/);
    expect(driver.calls.some((c) => c.args.includes("network") && c.args[0] === "network")).toBe(
      false,
    );
  });
});

describe("the image", () => {
  it("is the local dev tag until a release pins a digest, and the owner's override wins", () => {
    expect(resolveDesktopImage(undefined, {})).toEqual({
      image: "psyche-sandbox:desktop-dev",
      pinned: false,
    });
    expect(resolveDesktopImage("x:y", {})).toEqual({ image: "x:y", pinned: false });
    expect(resolveDesktopImage(undefined, { PSYCHE_SANDBOX_IMAGE: "z:1" })).toEqual({
      image: "z:1",
      pinned: false,
    });
  });
});
