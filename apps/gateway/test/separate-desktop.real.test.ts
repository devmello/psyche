import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices } from "@psyche/db";
import type { PermissionBroker } from "@psyche/protocol";
import { DesktopContainers } from "@psyche/sandbox";
import { afterAll, describe, expect, it } from "vitest";
import {
  type GrantedShare,
  SEPARATE_DESKTOP_ID,
  SeparateDesktop,
} from "../src/compose/separate-desktop.ts";
import { GuestSockets } from "../src/nodes/guest-sockets.ts";
import { startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * The separate desktop against a real rootless Podman and the real `desktop` image (design §13
 * step 6). Off unless `PSYCHE_REAL_PODMAN=1`; needs the image `psyche-sandbox:desktop-dev` (built
 * from deploy/sandbox-image with the Linux helper staged). It prints the numbers the PR reports.
 *
 * It also plays the attack from the third review: one task plants programs in the persistent
 * workspace (`/workspace/.local/bin/{stat,cat,mkdir,...}`) hoping the next start runs them before
 * the helper pairs, and reads the pairing token from the environment.
 */
const REAL = process.env.PSYCHE_REAL_PODMAN === "1";
const NAME = `psyche-desktop-${SEPARATE_DESKTOP_ID}`;

const podman = (...args: string[]): string =>
  execFileSync("podman", ["--cgroup-manager=cgroupfs", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const exec = (cmd: string): { code: number; out: string } => {
  try {
    return { code: 0, out: podman("exec", "--user", "1000:1000", NAME, "sh", "-c", cmd) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

/** The broker's `get`, over cards this test approves as the owner would. */
function approvals() {
  const store = new Map<string, Record<string, unknown>>();
  let n = 0;
  const broker = { get: async (id: string) => store.get(id) } as unknown as PermissionBroker;
  const share = (source: string, name: string, readOnly: boolean): GrantedShare => {
    const id = `apr_${++n}`;
    store.set(id, {
      id,
      kind: "separate_desktop_share",
      status: "approved",
      details: { granted: { path: source, mode: readOnly ? "ro" : "rw" } },
    });
    return { source, name, readOnly, approvalId: id };
  };
  return { broker, share };
}

describe.skipIf(!REAL)("a real separate desktop", () => {
  let t: TestGateway | null = null;
  let guests: GuestSockets | null = null;
  const shareDir = mkdtempSync(join(tmpdir(), "psyche-share-"));
  afterAll(async () => {
    guests?.closeAll();
    await t?.cleanup();
    rmSync(shareDir, { recursive: true, force: true });
    try {
      podman("rm", "--force", NAME);
      podman("volume", "rm", "--force", `${NAME}-workspace`);
    } catch {
      // Already gone.
    }
  });

  it("keeps its promises, hides the token, and a program planted by one task runs for no one", async () => {
    mkdirSync(join(shareDir, "docs"));
    writeFileSync(join(shareDir, "docs", "note.txt"), "hello from the host\n");
    mkdirSync(join(shareDir, "work"));
    mkdirSync(join(shareDir, "gitro", ".git", "hooks"), { recursive: true });
    mkdirSync(join(shareDir, "rwgit", ".git"), { recursive: true });
    const docs = join(shareDir, "docs");
    const work = join(shareDir, "work");
    const gitro = join(shareDir, "gitro");
    t = await startTestGateway();
    guests = new GuestSockets({ ctx: t.gateway.context, home: t.home });
    // Capture the token, only so the test can look for it.
    let token = "";
    const realOpen = guests.open.bind(guests);
    guests.open = async (c) => {
      const o = await realOpen(c);
      token = o.token;
      return o;
    };
    const desktop = new DesktopContainers();
    const backend = await desktop.requireBackend();
    let engineMs = 0;
    const realStart = desktop.start.bind(desktop);
    desktop.start = async (req) => {
      const at = Date.now();
      const out = await realStart(req);
      engineMs = Date.now() - at;
      return out;
    };
    const states: unknown[] = [];
    const grants = { last: undefined as string | undefined };
    const ap = approvals();
    const sd = new SeparateDesktop({
      broker: ap.broker,
      desktop,
      guests,
      home: t.home,
      pairTimeoutMs: 30_000,
      report: (st) => states.push(st),
      grants: {
        read: () => grants.last,
        write: (k) => {
          grants.last = k;
        },
      },
    });
    const taskShares = () => [
      ap.share(docs, "docs", true),
      ap.share(work, "work", false),
      ap.share(gitro, "gitro", true),
    ];

    // ---- Task A: the promises, the token, and the planting.
    await sd.use("real-A", { shares: taskShares() });
    const info = await sd.clientFor("separate_desktop").info();
    expect(t.gateway.context.nodes.transportOf(info.id)).toBe("container-guest");
    expect(t.gateway.context.nodes.hostHelper()).toBeUndefined();
    expect((await sd.clientFor("separate_desktop").invoke("health", {})).ok).toBe(true);

    const inspectText = podman("inspect", NAME);
    expect(token.length).toBeGreaterThan(30);
    // The token is nowhere an observer could read it: not in the engine's description of the
    // container (Config.Env included), and not in the environment of any process in it.
    expect(inspectText).not.toContain(token);
    const inspect = JSON.parse(inspectText)[0];
    expect(JSON.stringify(inspect.Config.Env)).not.toMatch(/TOKEN/i);
    const environs = exec('for f in /proc/[0-9]*/environ; do /usr/bin/tr "\\0" "\\n" < "$f"; done');
    expect(environs.out).not.toContain(token);
    expect(environs.out).not.toMatch(/PSYCHE_GUEST_TOKEN/);
    // The token file was emptied by the entrypoint (the host sees the same, now empty, file).
    expect(exec("/usr/bin/cat /run/psyche/token | /usr/bin/wc -c").out.trim()).toBe("0");
    expect(
      readFileSync(guests.socketPathFor(SEPARATE_DESKTOP_ID).replace(/\.sock$/, ".token"), "utf8"),
    ).toBe("");

    expect(inspect.HostConfig.NetworkMode).toBe("none");
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.Privileged).toBe(false);
    expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(inspect.HostConfig.Memory).toBe(2 * 1024 ** 3);
    const wsMount = (inspect.Mounts as { Destination: string; Options?: string[] }[]).find(
      (m) => m.Destination === "/workspace",
    );
    expect(wsMount?.Options ?? []).toEqual(expect.arrayContaining(["noexec"]));

    expect(exec("id -u").out.trim()).toBe("1000");
    // PATH names only the image's own folders.
    expect(exec("echo $PATH").out.trim()).toBe("/usr/local/bin:/usr/bin:/bin");
    // Apps keep their profile in the workspace: HOME is /workspace, not the host user's home.
    expect(exec("echo $HOME").out.trim()).toBe("/workspace");
    expect(exec("echo $XDG_DATA_DIRS:$XDG_CONFIG_DIRS").out.trim()).toBe("/usr/share:/etc/xdg");
    expect(exec("grep CapEff /proc/self/status").out).toMatch(/CapEff:\s*0+$/m);
    expect(exec("ls /sys/class/net").out.trim()).toBe("lo");
    expect(exec("test -e /home/dev && echo yes || echo no").out.trim()).toBe("no");
    expect(exec("touch /etc/psyche-test").code).not.toBe(0);
    expect(exec("touch /usr/psyche-test").code).not.toBe(0);
    expect(exec("echo x > /tmp/ok && echo x > /workspace/ok").code).toBe(0);
    // The share is read-only: reading works, writing, creating and deleting fail.
    expect(exec("cat /shares/docs/note.txt").out).toBe("hello from the host\n");
    expect(exec("echo x >> /shares/docs/note.txt").code).not.toBe(0);
    expect(exec("touch /shares/docs/new.txt").code).not.toBe(0);
    expect(exec("rm /shares/docs/note.txt").code).not.toBe(0);
    expect(existsSync(join(docs, "new.txt"))).toBe(false);
    expect(readFileSync(join(docs, "note.txt"), "utf8")).toBe("hello from the host\n");
    // A read-write share without git takes writes; a read-only one that holds a repository does not.
    expect(exec("touch /shares/work/new.txt").code).toBe(0);
    expect(existsSync(join(work, "new.txt"))).toBe(true);
    expect(exec("touch /shares/gitro/.git/config").code).not.toBe(0);
    expect(existsSync(join(gitro, ".git", "config"))).toBe(false);
    expect(exec("ls /shares").out.trim().split(/\s+/)).toEqual(["docs", "gitro", "work"]);
    expect(exec("ls /run/psyche").out.trim().split(/\s+/)).toEqual(["node.sock", "token"]);
    expect(
      exec(
        "python3 -c \"import socket; s=socket.socket(); s.settimeout(3); s.connect(('1.1.1.1',80))\"",
      ).code,
    ).not.toBe(0);

    // The planting: files in the persistent workspace that would shadow `stat`, `cat`, `mkdir`
    // and the programs the entrypoint starts, and that try to read the token from PID 1.
    const plant = (name: string) =>
      `printf '#!/bin/sh\\necho ${name} >> /workspace/planted-ran\\n/usr/bin/cat /proc/1/environ > /workspace/stolen-environ 2>/dev/null\\n/usr/bin/cat /run/psyche/token > /workspace/stolen-token 2>/dev/null\\nexit 0\\n' > /workspace/.local/bin/${name} && chmod +x /workspace/.local/bin/${name}`;
    expect(exec("mkdir -p /workspace/.local/bin").code).toBe(0);
    for (const name of [
      "stat",
      "cat",
      "mkdir",
      "mkfifo",
      "sleep",
      "dbus-daemon",
      "Xvfb",
      "chmod",
    ]) {
      expect(exec(plant(name)).code, name).toBe(0);
    }
    // And a session-bus service file, whose Exec= runs a trusted interpreter on a planted script
    // (noexec does not stop that): the session bus must never read it.
    expect(exec("mkdir -p /workspace/.local/share/dbus-1/services").code).toBe(0);
    expect(
      exec(
        "printf \"open('/workspace/dbus-ran', 'w').write('x')\n\" > /workspace/x.py && " +
          "printf '[D-BUS Service]\nName=psyche.test.Planted\nExec=/usr/bin/python3 /workspace/x.py\n' > /workspace/.local/share/dbus-1/services/x.service",
      ).code,
    ).toBe(0);
    // Even by its full path, a planted file does not run: the workspace is mounted noexec.
    const direct = exec("/workspace/.local/bin/stat");
    expect(direct.code).not.toBe(0);
    expect(direct.out).toMatch(/denied|not permitted/i);
    expect(existsSync("/workspace/planted-ran")).toBe(false);
    expect(exec("test -e /workspace/planted-ran && echo ran || echo clean").out.trim()).toBe(
      "clean",
    );

    await sd.release("real-A", { force: true });
    expect(podman("ps", "--all", "--format", "{{.Names}}").trim()).toBe("");

    // ---- Task B: same grants, so the workspace (and what A planted in it) is reused.
    const before = engineMs;
    const began = Date.now();
    await sd.use("real-B", { shares: taskShares() });
    const pairedMs = Date.now() - began;
    expect(before).toBeGreaterThan(0);
    // The planted programs are still there ...
    expect(exec("ls /workspace/.local/bin").out.trim().split(/\s+/)).toEqual(
      expect.arrayContaining(["stat", "cat", "mkdir", "Xvfb"]),
    );
    // ... and none of them ran during the entrypoint or at any time since: no marker, nothing stolen.
    expect(exec("test -e /workspace/planted-ran && echo ran || echo clean").out.trim()).toBe(
      "clean",
    );
    expect(exec("test -e /workspace/stolen-environ && echo stolen || echo clean").out.trim()).toBe(
      "clean",
    );
    expect(exec("test -e /workspace/stolen-token && echo stolen || echo clean").out.trim()).toBe(
      "clean",
    );
    // The helper paired (so the start's checks ran from the host and passed), as a guest.
    const infoB = await sd.clientFor("separate_desktop").info();
    expect(t.gateway.context.nodes.transportOf(infoB.id)).toBe("container-guest");
    expect(t.gateway.context.nodes.list().find((x) => x.id === infoB.id)?.kind).toBe("guest");
    const environsB = exec(
      'for f in /proc/[0-9]*/environ; do /usr/bin/tr "\\0" "\\n" < "$f"; done',
    );
    expect(environsB.out).not.toContain(token);
    expect(podman("inspect", NAME)).not.toContain(token);

    // The planted session-bus service is never started: the daemon reads the image's folder only.
    const bus =
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/run/bus /usr/bin/dbus-send --session --print-reply";
    const planted = exec(`${bus} --dest=psyche.test.Planted / org.freedesktop.DBus.Peer.Ping`);
    expect(planted.code).not.toBe(0);
    expect(planted.out).toMatch(/ServiceUnknown|not activatable|was not provided/i);
    await new Promise((r) => setTimeout(r, 1500));
    expect(exec("test -e /workspace/dbus-ran && echo ran || echo clean").out.trim()).toBe("clean");
    expect(exec("test -e /workspace/x.py && echo planted || echo missing").out.trim()).toBe(
      "planted",
    );
    // The image's own services still activate: an activatable name nobody owns yet (the dconf
    // service) is started from the folder the bus does list.
    expect(exec(`${bus} --dest=ca.desrt.dconf / org.freedesktop.DBus.Peer.Ping`).code).toBe(0);

    // The daemons the Gateway trusts run with a home under /tmp; the rest keeps /workspace.
    const homeOf = (comm: string) =>
      exec(
        `for p in /proc/[0-9]*; do read c < $p/comm; if [ "$c" = "${comm}" ]; then /usr/bin/grep -a -o -E '(HOME|XDG_[A-Z]+_HOME)=[^[:cntrl:]]*' $p/environ; fi; done`,
      ).out;
    for (const daemon of ["dbus-daemon", "Xvfb", "at-spi-bus-laun"]) {
      const env = homeOf(daemon);
      expect(env, daemon).toContain("HOME=/tmp/trusted-home");
      expect(env, daemon).toContain("XDG_DATA_HOME=/tmp/trusted-home/data");
      expect(env, daemon).toContain("XDG_CONFIG_HOME=/tmp/trusted-home/config");
      expect(env, daemon).toContain("XDG_CACHE_HOME=/tmp/trusted-home/cache");
      expect(env, daemon).not.toContain("/workspace");
    }
    // (The helper itself is not dumpable, so its environment can't be read; the container's
    // init, which started it with the same environment, shows what it was given.)
    expect(homeOf("tini")).toContain("HOME=/workspace");

    // The lockdown files are in place: Firefox extensions blocked, LibreOffice macros locked off.
    expect(
      exec(
        'grep -c \'"installation_mode": "blocked"\' /etc/firefox/policies/policies.json',
      ).out.trim(),
    ).toBe("1");
    expect(
      exec(
        "grep -c '<prop .*finalized=\"true\"' /usr/lib/libreoffice/share/registry/zz-psyche-lockdown.xcd",
      ).out.trim(),
    ).toBe("2");

    // A long-lived app opens on the display and keeps its profile in the workspace (Firefox ESR uses ~/.config/mozilla).
    exec("DISPLAY=:1 nohup /usr/bin/firefox-esr --no-remote about:blank > /tmp/firefox.log 2>&1 &");
    await new Promise((r) => setTimeout(r, 10_000));
    const apps = exec("/usr/bin/ps -eo comm= | /usr/bin/sort | /usr/bin/uniq -c").out;
    expect(apps).toMatch(/Xvfb/);
    expect(apps).toMatch(/firefox/);
    expect(apps).toMatch(/psyche-helper/);
    expect(
      exec(
        "test -d /workspace/.config/mozilla -o -d /workspace/.mozilla && echo yes || echo no",
      ).out.trim(),
    ).toBe("yes");

    // Numbers.
    const stats = JSON.parse(podman("stats", "--no-stream", "--format", "json", NAME))[0];
    const rss = exec("/usr/bin/ps -eo rss= | /usr/bin/awk '{s+=$1} END {print s}'").out.trim();
    const img = JSON.parse(podman("image", "inspect", "psyche-sandbox:desktop-dev"))[0].Size;
    process.stdout.write(`[real] state: ${JSON.stringify(states.at(-1))}\n`);
    process.stdout.write(
      `[real] engine=${backend.kind} ${backend.version} rootless=${backend.rootless} image=${(img / 1e9).toFixed(2)}GB ` +
        `container_up_ms=${engineMs} start_to_paired_ms=${pairedMs} sum_rss_kb=${rss} mem_usage=${stats.mem_usage ?? stats.MemUsage}\n`,
    );

    // A read-write share holding a repository never starts.
    await sd.release("real-B", { force: true });
    await expect(
      sd.use("real-C", { shares: [ap.share(join(shareDir, "rwgit"), "rwgit", false)] }),
    ).rejects.toMatchObject({ details: { reason: "git_in_read_write_share" } });
    // End: everything is gone.
    expect(podman("ps", "--all", "--format", "{{.Names}}").trim()).toBe("");
    expect(existsSync(guests.socketPathFor(SEPARATE_DESKTOP_ID))).toBe(false);
    expect(
      listDevices(t.gateway.context.db).some((d) => d.name.startsWith("Separate desktop")),
    ).toBe(false);
    expect(t.gateway.context.nodes.isLive(infoB.id)).toBe(false);
  }, 300_000);
});
