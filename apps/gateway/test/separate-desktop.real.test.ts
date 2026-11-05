import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices } from "@psyche/db";
import { DesktopContainers } from "@psyche/sandbox";
import { afterAll, describe, expect, it } from "vitest";
import { SEPARATE_DESKTOP_ID, SeparateDesktop } from "../src/compose/separate-desktop.ts";
import { GuestSockets } from "../src/nodes/guest-sockets.ts";
import { startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * The separate desktop against a real rootless Podman and the real `desktop` image (design §13
 * step 6). Off unless `PSYCHE_REAL_PODMAN=1`; needs the image `psyche-sandbox:desktop-dev` (built
 * from deploy/sandbox-image with the Linux helper staged) and, for the pairing check, a helper
 * that speaks the node protocol. It prints the numbers the PR reports.
 */
const REAL = process.env.PSYCHE_REAL_PODMAN === "1";

const podman = (...args: string[]): string =>
  execFileSync("podman", ["--cgroup-manager=cgroupfs", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const exec = (cmd: string): { code: number; out: string } => {
  try {
    return {
      code: 0,
      out: podman(
        "exec",
        "--user",
        "1000:1000",
        `psyche-desktop-${SEPARATE_DESKTOP_ID}`,
        "sh",
        "-c",
        cmd,
      ),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

describe.skipIf(!REAL)("a real separate desktop", () => {
  let t: TestGateway | null = null;
  let guests: GuestSockets | null = null;
  const shareDir = mkdtempSync(join(tmpdir(), "psyche-share-"));
  afterAll(async () => {
    guests?.closeAll();
    await t?.cleanup();
    rmSync(shareDir, { recursive: true, force: true });
    try {
      podman("rm", "--force", `psyche-desktop-${SEPARATE_DESKTOP_ID}`);
    } catch {
      // Already gone.
    }
  });

  it("starts without network, pairs as a guest over the mounted socket, keeps its promises, and leaves nothing", async () => {
    mkdirSync(join(shareDir, "docs"));
    writeFileSync(join(shareDir, "docs", "note.txt"), "hello from the host\n");
    const share = join(shareDir, "docs");
    t = await startTestGateway();
    guests = new GuestSockets({ ctx: t.gateway.context, home: t.home });
    const desktop = new DesktopContainers();
    const backend = await desktop.requireBackend();
    const sd = new SeparateDesktop({ desktop, guests, home: t.home, pairTimeoutMs: 30_000 });

    // Time the engine's part (create, start, up) apart from the helper's pairing.
    let engineMs = 0;
    const realStart = desktop.start.bind(desktop);
    desktop.start = async (req) => {
      const at = Date.now();
      const out = await realStart(req);
      engineMs = Date.now() - at;
      return out;
    };
    const began = Date.now();
    await sd.use("real-1", { shares: [{ source: share, name: "docs", readOnly: true }] });
    const readyMs = Date.now() - began;

    // Paired as a guest bound to the container, on the container's socket only.
    const client = sd.clientFor("separate_desktop");
    const info = await client.info();
    expect(t.gateway.context.nodes.transportOf(info.id)).toBe("container-guest");
    expect(t.gateway.context.nodes.hostHelper()).toBeUndefined();
    const health = await client.invoke("health", {});
    expect(health.ok).toBe(true);

    // The container as the engine sees it.
    const inspect = JSON.parse(podman("inspect", `psyche-desktop-${SEPARATE_DESKTOP_ID}`))[0];
    expect(inspect.HostConfig.NetworkMode).toBe("none");
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.Privileged).toBe(false);
    expect(inspect.HostConfig.CapDrop).toEqual(expect.arrayContaining(["CAP_CHOWN"]));
    expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(inspect.HostConfig.Memory).toBe(2 * 1024 ** 3);

    // Inside: the user, no capabilities, no network but loopback, no host home, read-only root.
    expect(exec("id -u").out.trim()).toBe("1000");
    expect(exec("grep CapEff /proc/self/status").out).toMatch(/CapEff:\s*0+$/m);
    expect(exec("ls /sys/class/net").out.trim()).toBe("lo");
    expect(exec("ls /home 2>&1; ls /home/dev 2>&1; ls /root 2>&1").out).not.toMatch(
      /wt|\.psyche|\.ssh|Documents/,
    );
    expect(exec("test -e /home/dev && echo yes || echo no").out.trim()).toBe("no");
    expect(exec("touch /etc/psyche-test").code).not.toBe(0);
    expect(exec("touch /usr/psyche-test").code).not.toBe(0);
    expect(exec("echo x > /tmp/ok && echo x > /workspace/ok").code).toBe(0);
    // The share is read-only: reading works, writing, creating and deleting fail.
    expect(exec("cat /shares/docs/note.txt").out).toBe("hello from the host\n");
    expect(exec("echo x >> /shares/docs/note.txt").code).not.toBe(0);
    expect(exec("touch /shares/docs/new.txt").code).not.toBe(0);
    expect(exec("rm /shares/docs/note.txt").code).not.toBe(0);
    expect(existsSync(join(share, "new.txt"))).toBe(false);
    expect(readFileSync(join(share, "note.txt"), "utf8")).toBe("hello from the host\n");
    // Nothing else of the host is there.
    expect(exec("ls /shares").out.trim()).toBe("docs");
    expect(exec("ls /run/psyche").out.trim()).toBe("node.sock");
    expect(
      exec(
        "test -e /var/run/docker.sock -o -e /run/podman/podman.sock && echo yes || echo no",
      ).out.trim(),
    ).toBe("no");
    // No way out to the network: the proxy variables point at a shim that is not running.
    expect(
      exec(
        "python3 -c \"import socket; s=socket.socket(); s.settimeout(3); s.connect(('1.1.1.1',80))\"",
      ).code,
    ).not.toBe(0);
    expect(
      exec(
        "python3 -c \"import socket; s=socket.socket(); s.settimeout(3); s.connect(('127.0.0.1',3128))\"",
      ).code,
    ).not.toBe(0);

    // An app opens on the display (the file manager), and stays up.
    exec("DISPLAY=:1 nohup pcmanfm --no-desktop /workspace > /tmp/pcmanfm.log 2>&1 &");
    await new Promise((r) => setTimeout(r, 4000));
    const apps = exec("ps -eo comm= | sort | uniq -c").out;
    console.log("[real] processes:\n" + apps);
    expect(apps).toMatch(/Xvfb/);
    expect(apps).toMatch(/pcmanfm/);
    expect(apps).toMatch(/psyche-helper/);

    // Numbers.
    const stats = JSON.parse(
      podman("stats", "--no-stream", "--format", "json", `psyche-desktop-${SEPARATE_DESKTOP_ID}`),
    )[0];
    const rss = exec("ps -eo rss= | awk '{s+=$1} END {print s}'").out.trim();
    const img = JSON.parse(podman("image", "inspect", "psyche-sandbox:desktop-dev"))[0].Size;
    console.log(
      `[real] engine=${backend.kind} ${backend.version} rootless=${backend.rootless} image=${(img / 1e9).toFixed(2)}GB ` +
        `container_up_ms=${engineMs} start_to_paired_ms=${readyMs} sum_rss_kb=${rss} mem_usage=${stats.mem_usage ?? stats.MemUsage}`,
    );

    // End of the task: everything is gone.
    await sd.release("real-1", { force: true });
    expect(podman("ps", "--all", "--format", "{{.Names}}").trim()).toBe("");
    expect(existsSync(guests.socketPathFor(SEPARATE_DESKTOP_ID))).toBe(false);
    expect(
      listDevices(t.gateway.context.db).some((d) => d.name.startsWith("Separate desktop")),
    ).toBe(false);
    expect(t.gateway.context.nodes.isLive(info.id)).toBe(false);
  }, 240_000);
});
