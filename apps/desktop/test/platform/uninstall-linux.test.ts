import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE_CONFIRM_WORD, UninstallError } from "../../src/main/uninstall.ts";
import { renderGatewayUnit } from "../../src/platform/systemd-unit.ts";
import {
  confirmTextLinux,
  type LinuxUninstallDeps,
  linuxUnitOwner,
  packageRemoveArgv,
  planUninstallLinux,
  psycheHomeFromUnit,
  runUninstallLinux,
} from "../../src/platform/uninstall-linux.ts";

/**
 * A temporary HOME with fake systemctl, podman, pkexec, trash and quit: the real unit, the real
 * ~/.psyche and the real package are never touched.
 */

let root: string;
let home: string;
let calls: string[];
let trashed: string[];
let removed: string[];
let active: number; // polls left in which the unit still reports active
let confirmAnswer: boolean;
let pkexecCode: number;
let quit: number;
let deps: LinuxUninstallDeps;

const mk = (...p: string[]) => mkdirSync(join(...p), { recursive: true });
const touch = (p: string) => {
  mk(join(p, ".."));
  writeFileSync(p, "x");
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psyche-uninstall-linux-")));
  home = join(root, "home");
  calls = [];
  trashed = [];
  removed = [];
  active = 0;
  confirmAnswer = true;
  pkexecCode = 0;
  quit = 0;
  mk(home, ".config", "Psyche");
  mk(home, ".cache", "psyche");
  mk(home, ".local", "state", "psyche-helper");
  mk(home, ".local", "share", "psyche", "previous");
  touch(join(home, ".config", "systemd", "user", "psyche-gateway.service"));
  touch(join(home, ".config", "autostart", "psyche.desktop"));
  touch(join(home, ".local", "share", "applications", "psyche.desktop"));
  mk(home, ".psyche", "state");
  writeFileSync(join(home, ".psyche", "state", "psyche.sqlite"), "db");
  const image = join(root, "Apps", "Psyche.AppImage");
  touch(image);
  deps = {
    userHome: home,
    env: {},
    psycheHome: join(home, ".psyche"),
    install: "appimage",
    appImagePath: image,
    packageManager: undefined,
    locale: "en-US",
    run: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "pkexec") return { code: pkexecCode, stdout: "", stderr: "E: Unable to locate" };
      return { code: 0, stdout: "", stderr: "" };
    },
    trashItem: async (p) => {
      trashed.push(p);
    },
    removePath: (p) => {
      removed.push(p);
    },
    setOpenAtLogin: (v) => calls.push(`login ${v}`),
    unitOwner: () => "ours",
    unitActive: async () => active-- > 0,
    restartGateway: async () => {
      calls.push("restart");
    },
    clearStagedUpdate: async () => [],
    authorizeDelete: async (p) => {
      calls.push(`authorize ${p}`);
    },
    confirm: async () => confirmAnswer,
    closeWindows: () => calls.push("close"),
    quit: () => {
      quit++;
    },
    sleep: async () => undefined,
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("planUninstallLinux", () => {
  it("lists what is stopped, removed and trashed, and keeps the data by default", () => {
    const plan = planUninstallLinux(deps, { deleteData: false });
    expect(plan.agent).toBe("ours");
    expect(plan.stops.map((s) => s.kind)).toEqual(["agent", "helper", "service"]);
    expect(plan.remove.map((i) => i.path)).toEqual([
      join(home, ".config", "systemd", "user", "psyche-gateway.service"),
      join(home, ".config", "autostart", "psyche.desktop"),
      join(home, ".local", "share", "applications", "psyche.desktop"),
    ]);
    expect(plan.trash.map((i) => i.kind)).toEqual(["support", "cache", "state", "cache", "app"]);
    expect(plan.trash.at(-1)?.path).toBe(deps.appImagePath);
    expect(plan.trash.some((i) => i.kind === "data")).toBe(false);
    expect(plan.dataFolder).toBeUndefined();
    expect(plan.keychain).toEqual([]);
  });

  it("follows the XDG variables", () => {
    const plan = planUninstallLinux(
      { ...deps, env: { XDG_CACHE_HOME: join(home, "c") } },
      { deleteData: false },
    );
    expect(plan.trash.some((i) => i.path === join(home, "c", "psyche"))).toBe(false); // does not exist
    mk(home, "c", "psyche");
    const again = planUninstallLinux(
      { ...deps, env: { XDG_CACHE_HOME: join(home, "c") } },
      { deleteData: false },
    );
    expect(again.trash.some((i) => i.path === join(home, "c", "psyche"))).toBe(true);
  });

  it("another copy's unit is left alone with a warning", () => {
    const plan = planUninstallLinux({ ...deps, unitOwner: () => "other" }, { deleteData: false });
    expect(plan.agent).toBe("other");
    expect(plan.stops.some((s) => s.kind === "agent")).toBe(false);
    expect(plan.remove.some((i) => i.path.endsWith("psyche-gateway.service"))).toBe(false);
    expect(plan.warnings).toHaveLength(1);
  });

  it("with the data checkbox adds the data folder, and refuses an unsafe one", () => {
    const plan = planUninstallLinux(deps, { deleteData: true });
    expect(plan.dataFolder).toBe(join(home, ".psyche"));
    expect(plan.trash.some((i) => i.kind === "data")).toBe(true);
    expect(() => planUninstallLinux({ ...deps, psycheHome: home }, { deleteData: true })).toThrow(
      UninstallError,
    );
    expect(() =>
      planUninstallLinux({ ...deps, psycheHome: join(home, "elsewhere") }, { deleteData: true }),
    ).toThrow(/no Psyche marker/);
  });

  it("deb/rpm: shows the exact command and moves no app file", () => {
    const apt = planUninstallLinux(
      { ...deps, install: "package", appImagePath: null, packageManager: "apt" },
      { deleteData: false },
    );
    expect(apt.packageCommand).toBe("sudo apt remove psyche");
    expect(apt.trash.some((i) => i.kind === "app")).toBe(false);
    expect(apt.warnings.join(" ")).toContain("sudo apt remove psyche");
    const dnf = planUninstallLinux(
      { ...deps, install: "package", appImagePath: null, packageManager: "dnf" },
      { deleteData: false },
    );
    expect(dnf.packageCommand).toBe("sudo dnf remove psyche");
    expect(packageRemoveArgv("apt")).toEqual(["pkexec", ["apt-get", "remove", "-y", "psyche"]]);
    expect(() =>
      planUninstallLinux(
        { ...deps, install: "package", appImagePath: null, packageManager: undefined },
        { deleteData: false },
      ),
    ).toThrow(/package manager/);
  });

  it("refuses to move a file that is not an .AppImage", () => {
    const odd = join(root, "Apps", "psyche-binary");
    touch(odd);
    expect(() => planUninstallLinux({ ...deps, appImagePath: odd }, { deleteData: false })).toThrow(
      /not an .AppImage/,
    );
  });
});

describe("runUninstallLinux", () => {
  it("stops the helper, containers and Gateway, removes what Psyche wrote, trashes the rest, quits", async () => {
    const res = await runUninstallLinux(deps, { deleteData: false });
    expect(res.failed).toEqual([]);
    expect(calls).toEqual([
      "login false",
      "systemctl --user stop psyche-helper.service",
      "podman rm -f --filter label=com.psyche.owner=1",
      "systemctl --user disable --now psyche-gateway.service",
      "systemctl --user daemon-reload",
      "close",
    ]);
    expect(removed).toHaveLength(3);
    expect(trashed.at(-1)).toBe(deps.appImagePath);
    expect(trashed).not.toContain(join(home, ".psyche"));
    expect(quit).toBe(1);
  });

  it("only Psyche's own containers are removed (matched by label)", async () => {
    await runUninstallLinux(deps, { deleteData: false });
    const podman = calls.filter((c) => c.startsWith("podman"));
    expect(podman).toEqual(["podman rm -f --filter label=com.psyche.owner=1"]);
  });

  it("deleting data needs the typed word and the Gateway's presence gate", async () => {
    await expect(runUninstallLinux(deps, { deleteData: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await runUninstallLinux(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD });
    expect(calls).toContain(`authorize ${join(home, ".psyche")}`);
    expect(trashed).toContain(join(home, ".psyche"));
  });

  it("a cancelled confirmation changes nothing", async () => {
    confirmAnswer = false;
    await expect(runUninstallLinux(deps, { deleteData: false })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(calls).toEqual([]);
    expect(trashed).toEqual([]);
    expect(quit).toBe(0);
  });

  it("a Gateway that will not stop is started again and nothing is moved", async () => {
    active = 1000;
    await expect(runUninstallLinux(deps, { deleteData: false })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(calls).toContain("restart");
    expect(trashed).toEqual([]);
    expect(removed).toEqual([]);
    expect(quit).toBe(0);
  });

  it("a failed trash keeps the app open and brings the Gateway back", async () => {
    deps.trashItem = async (p) => {
      if (p.endsWith(".cache/psyche")) throw new Error("denied");
      trashed.push(p);
    };
    const res = await runUninstallLinux(deps, { deleteData: false });
    expect(res.failed).toHaveLength(1);
    expect(res.restarted).toBe(true);
    expect(quit).toBe(0);
    expect(trashed).not.toContain(deps.appImagePath);
  });

  it("deb/rpm: removes the package through pkexec last; a failure leaves the command to run", async () => {
    const pkg = {
      ...deps,
      install: "package" as const,
      appImagePath: null,
      packageManager: "apt" as const,
    };
    await runUninstallLinux(pkg, { deleteData: false });
    expect(calls.at(-1)).toBe("pkexec apt-get remove -y psyche");
    expect(quit).toBe(1);
    calls = [];
    pkexecCode = 126;
    const res = await runUninstallLinux(pkg, { deleteData: false });
    expect(res.failed).toEqual([{ path: "sudo apt remove psyche", reason: "E: Unable to locate" }]);
    expect(res.packageFailed).toContain("sudo apt remove psyche");
    expect(quit).toBe(1); // still only the first run
  });
});

describe("helpers", () => {
  it("unit owner: a package's unit is ours; an AppImage's depends on what it runs", () => {
    const file = join(home, ".config", "systemd", "user", "psyche-gateway.service");
    writeFileSync(file, renderGatewayUnit({ program: "/a/Psyche.AppImage", args: ["--psyched"] }));
    expect(linuxUnitOwner({ install: "package", unitFile: file, program: "/x" })).toBe("ours");
    expect(
      linuxUnitOwner({ install: "appimage", unitFile: file, program: "/a/Psyche.AppImage" }),
    ).toBe("ours");
    expect(
      linuxUnitOwner({ install: "appimage", unitFile: file, program: "/b/Other.AppImage" }),
    ).toBe("other");
    expect(linuxUnitOwner({ install: "appimage", unitFile: file + ".nope", program: "/a" })).toBe(
      "none",
    );
  });

  it("reads PSYCHE_HOME from the unit or its drop-in", () => {
    expect(
      psycheHomeFromUnit(
        renderGatewayUnit({ program: "/p", psycheHome: "/data/psyche", profile: "desktop" }),
      ),
    ).toBe("/data/psyche");
    expect(psycheHomeFromUnit("[Service]\n")).toBeUndefined();
  });

  it("the confirmation text is in the OS language and names the package command", () => {
    const plan = planUninstallLinux(
      { ...deps, install: "package", appImagePath: null, packageManager: "dnf", locale: "de-DE" },
      { deleteData: false },
    );
    const en = confirmTextLinux(plan, "en-US");
    const de = confirmTextLinux(plan, "de-DE");
    expect(en.detail).toContain("sudo dnf remove psyche");
    expect(de.title).not.toBe(en.title);
    expect(existsSync(home)).toBe(true);
  });
});
