import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_FILE, privacyOf } from "@psyche/hostfs/testing";
import { afterAll, describe, expect, it } from "vitest";
import { renderScheduledTaskXml, writeTaskXml } from "../../../cli/src/supervisor.ts";
import { chooseMode, devGatewayCommand, type Runner } from "../../src/main/supervisor.ts";
import {
  bundledGatewayPaths,
  decodeTaskXml,
  encodeTaskXml,
  fillTaskTemplate,
  GATEWAY_PID_FILE,
  gatewayServiceConfig,
  gatewayServiceConfigFile,
  gatewayTaskFile,
  isTemporaryLocation,
  LEGACY_GATEWAY_TASK,
  parseCsvRow,
  parseLastResult,
  quoteWindowsArg,
  SERVICE_PID_FILE,
  schtasks,
  splitWindowsArgs,
  TaskSchedulerSupervisor,
  taskProgram,
  taskUri,
  windowsUserId,
} from "../../src/main/supervisor-windows.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const TASK = `\\Psyche\\Gateway-${SID}`;

const dir = mkdtempSync(join(tmpdir(), "psy-wsup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The template exactly as deploy/scripts/build-psyched.mjs writes it into the bundle. */
function bundleTemplate(): string {
  const d = "{{PSYCHED_DIR}}";
  return renderScheduledTaskXml({
    node: `${d}\\runtime\\node.exe`,
    serviceHost: `${d}\\service-host.mjs`,
    program: `${d}\\runtime\\node.exe`,
    args: [
      "--max-semi-space-size=4",
      "--disable-warning=ExperimentalWarning",
      `${d}\\app\\apps\\gateway\\dist\\main.mjs`,
    ],
    psycheHome: "{{PSYCHE_HOME}}",
    userId: "{{USER_ID}}",
    taskName: "{{TASK_NAME}}",
  });
}

describe("Windows supervisor mode", () => {
  it("is Task Scheduler when packaged on Windows; a forced launchd means the OS's own service", () => {
    expect(chooseMode({}, true, "win32")).toBe("taskscheduler");
    expect(chooseMode({}, false, "win32")).toBe("dev");
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "launchd" }, true, "win32")).toBe("taskscheduler");
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "taskscheduler" }, true, "darwin")).toBe("launchd");
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "external" }, true, "win32")).toBe("external");
  });

  it("runs the dev Gateway through the system node and tsx's CLI (no .cmd shim)", () => {
    const gw = join("repo", "apps", "gateway");
    const cli = join(gw, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
    expect(devGatewayCommand(gw, "win32", (p) => p === cli)).toEqual({
      command: "node",
      args: [cli, "src/main.ts"],
    });
    const bin = join(gw, "..", "..", "node_modules", ".bin", "tsx");
    expect(devGatewayCommand(gw, "darwin", (p) => p === bin)).toEqual({
      command: bin,
      args: ["src/main.ts"],
    });
    expect(devGatewayCommand(gw, "win32", () => false)).toBeUndefined();
  });

  it("finds the bundled runtime and task template in resources\\psyched", () => {
    const r = "C:\\P\\resources";
    expect(bundledGatewayPaths(r)).toEqual({
      dir: join(r, "psyched"),
      node: join(r, "psyched", "runtime", "node.exe"),
      entry: join(r, "psyched", "app", "apps", "gateway", "dist", "main.mjs"),
      template: join(r, "psyched", "psyche-gateway.task.xml.template"),
    });
    expect(windowsUserId({ USERDOMAIN: "HOST", USERNAME: "ada" })).toBe("HOST\\ada");
    expect(windowsUserId({ USERNAME: "ada" })).toBe("ada");
    expect(windowsUserId({})).toBeUndefined();
  });
});

describe("Windows command lines", () => {
  it("quotes like CommandLineToArgvW and splits back to the same argv", () => {
    const args = ["plain", "with space", "C:\\dir with space\\", 'quote"inside', "", "b\\\\s\\"];
    expect(splitWindowsArgs(args.map(quoteWindowsArg).join(" "))).toEqual(args);
    expect(quoteWindowsArg("--headless")).toBe("--headless");
  });

  it("reads schtasks' CSV in any language (by column)", () => {
    expect(parseCsvRow('"a","b ""q""",c')).toEqual(["a", 'b "q"', "c"]);
    const row =
      '"HOST","\\Psyche\\Gateway","N/A","Wird ausgeführt","Nur interaktiv","05.11.2026","1","N/A","C:\\x"';
    expect(parseLastResult(row)).toBe("1");
    expect(parseLastResult("")).toBeUndefined();
  });

  it("names the task it is given (this account's \\Psyche\\Gateway-<SID>)", () => {
    expect(schtasks.create(TASK, "C:\\h\\run\\psyche-gateway.task.xml")).toEqual([
      "/Create",
      "/TN",
      TASK,
      "/XML",
      "C:\\h\\run\\psyche-gateway.task.xml",
      "/F",
    ]);
    expect(schtasks.end(TASK)).toEqual(["/End", "/TN", TASK]);
    expect(schtasks.delete(TASK)).toEqual(["/Delete", "/TN", TASK, "/F"]);
    expect(LEGACY_GATEWAY_TASK).toBe("\\Psyche\\Gateway");
    expect(gatewayTaskFile("C:\\h")).toBe(join("C:\\h", "run", "psyche-gateway.task.xml"));
  });

  it("never registers a runtime inside the temp folder (an exe run from inside a ZIP)", () => {
    expect(isTemporaryLocation(join(tmpdir(), "Temp1_psyche.zip", "node.exe"))).toBe(true);
    expect(isTemporaryLocation("D:\\Apps\\node.exe", join(dir, "t"))).toBe(false);
  });
});

describe("the bundled task template", () => {
  const values = {
    psychedDir: "C:\\Users\\Ada & Co\\AppData\\Local\\Psyche\\app-0.3.0\\resources\\psyched",
    psycheHome: "C:\\Users\\Ada & Co\\.psyche",
    userId: "HOST\\Ada",
    taskName: TASK,
  };
  const xml = fillTaskTemplate(bundleTemplate(), values);

  it("fills every placeholder, XML-escaped, and reads back the runtime it runs", () => {
    expect(xml).not.toContain("{{");
    expect(xml).toContain("<UserId>HOST\\Ada</UserId>");
    expect(xml).not.toContain("Ada & Co");
    expect(taskProgram(xml)).toBe(`${values.psychedDir}\\runtime\\node.exe`);
    expect(xml).toContain(`<URI>${TASK}</URI>`);
    expect(taskUri(xml)).toBe(TASK);
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toMatch(/<Command>%SystemRoot%\\System32\\conhost\.exe<\/Command>/);
  });

  it("drops a trailing backslash, which would escape the closing quote", () => {
    const filled = fillTaskTemplate(bundleTemplate(), { ...values, psychedDir: "C:\\P\\" });
    expect(taskProgram(filled)).toBe("C:\\P\\runtime\\node.exe");
  });

  it("round-trips through the UTF-16 file schtasks reads (and the CLI writes)", () => {
    const buf = encodeTaskXml(xml);
    expect([buf[0], buf[1]]).toEqual([0xff, 0xfe]);
    expect(decodeTaskXml(buf)).toBe(xml);
    const file = join(dir, "cli.xml");
    writeTaskXml(file, xml);
    expect(readFileSync(file).equals(buf)).toBe(true);
  });
});

/**
 * A fake Task Scheduler and taskkill, by task name: registered after /Create, healthy once run.
 * `registered` is this account's task, `legacy` a \\Psyche\\Gateway of an earlier version.
 */
function scheduler(o: { neverHealthy?: boolean; registered?: string; legacy?: string } = {}) {
  const calls: string[][] = [];
  const tasks = new Map<string, string>();
  if (o.registered !== undefined) tasks.set(TASK, o.registered);
  if (o.legacy !== undefined) tasks.set(LEGACY_GATEWAY_TASK, o.legacy);
  let running = false;
  const run: Runner = async (file, args) => {
    const exe = (file.split("\\").pop() ?? file).toLowerCase();
    calls.push([exe, ...args]);
    if (exe === "taskkill.exe") {
      running = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (exe !== "schtasks.exe") return { code: 0, stdout: "", stderr: "" };
    const verb = args[0];
    const name = args[2] as string;
    if (verb === "/Create") tasks.set(name, decodeTaskXml(readFileSync(args[4] as string)));
    if (verb === "/Delete") tasks.delete(name);
    if (verb === "/Run") running = tasks.has(name);
    if (verb === "/End") running = false;
    if (verb === "/Query") {
      const xml = tasks.get(name);
      if (xml === undefined) return { code: 1, stdout: "", stderr: "not found" };
      if (args.includes("/XML")) return { code: 0, stdout: xml, stderr: "" };
      if (args.includes("/V"))
        return { code: 0, stdout: `"H","${name}","N/A","Ready","I","x","3"`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchFn: typeof fetch = () =>
    running && !o.neverHealthy
      ? Promise.resolve(new Response("{}", { status: 200 }))
      : Promise.reject(new Error("down"));
  return {
    calls,
    run,
    fetch: fetchFn,
    registered: () => tasks.get(TASK),
    legacy: () => tasks.get(LEGACY_GATEWAY_TASK),
    start: () => {
      running = true;
    },
  };
}

function bundle(name: string) {
  const root = join(dir, name);
  const psyched = join(root, "psyched");
  mkdirSync(join(psyched, "runtime"), { recursive: true });
  writeFileSync(join(psyched, "runtime", "node.exe"), "");
  const template = join(psyched, "psyche-gateway.task.xml.template");
  writeTaskXml(template, bundleTemplate());
  return {
    psyched,
    node: join(psyched, "runtime", "node.exe"),
    template,
    home: join(root, "home"),
  };
}

function supervisor(b: ReturnType<typeof bundle>, f: ReturnType<typeof scheduler>, more = {}) {
  return new TaskSchedulerSupervisor({
    mode: "taskscheduler",
    psycheHome: b.home,
    healthUrl: "http://127.0.0.1:1/healthz",
    bundledPsyched: b.psyched,
    bundledNode: b.node,
    bundledTemplate: b.template,
    userId: "HOST\\ada",
    userSid: SID,
    systemRoot: "C:\\Windows",
    // The test bundles live in the temp folder, which a real install never does.
    tempDir: join(dir, "elsewhere"),
    run: f.run,
    fetch: f.fetch,
    sleep: async () => undefined,
    ...more,
  });
}

describe("TaskSchedulerSupervisor", () => {
  const verbs = (calls: string[][]) =>
    calls.filter((c) => c[0] === "schtasks.exe" && c[3] !== LEGACY_GATEWAY_TASK).map((c) => c[1]);
  const legacyCalls = (calls: string[][]) =>
    calls.filter((c) => c[0] === "schtasks.exe" && c[3] === LEGACY_GATEWAY_TASK).map((c) => c[1]);

  it("registers the filled template, runs it and waits for /healthz; a second launch changes nothing", async () => {
    const b = bundle("fresh");
    const f = scheduler();
    const states: string[] = [];
    const sup = supervisor(b, f, {
      onState: (s: { kind: string; step?: string }) =>
        states.push(`${s.kind}${s.step ? `:${s.step}` : ""}`),
    });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({ kind: "running", mode: "taskscheduler" });
    expect(verbs(f.calls)).toEqual(["/Query", "/Create", "/Run", "/Query"]);
    expect(states).toEqual(["starting:installing", "starting:waiting", "running"]);
    const stored = decodeTaskXml(readFileSync(gatewayTaskFile(b.home)));
    expect(stored).toBe(f.registered());
    expect(taskProgram(stored)).toBe(b.node);
    expect(taskUri(stored)).toBe(TASK);
    // Looked for an earlier version's shared task, found none, left it at that.
    expect(legacyCalls(f.calls)).toEqual(["/Query"]);
    expect(existsSync(join(b.home, "logs"))).toBe(true);

    f.calls.length = 0;
    await sup.ensureRunning();
    expect(verbs(f.calls)).toEqual(["/Query", "/Query"]);
  });

  it("reports a Gateway that never answers with the task's last result and the logs folder", async () => {
    const b = bundle("silent");
    const f = scheduler({ neverHealthy: true });
    const sup = supervisor(b, f, { healthTimeoutMs: 0 });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({
      kind: "stopped",
      mode: "taskscheduler",
      reason: "The Gateway did not answer within 0 s (last exit code 3)",
      logs: join(b.home, "logs"),
    });
  });

  it("says when nothing is bundled, and attaches to a Gateway it did not start", async () => {
    const f = scheduler();
    const none = new TaskSchedulerSupervisor({
      mode: "taskscheduler",
      userSid: SID,
      psycheHome: join(dir, "nobundle"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledPsyched: join(dir, "nope"),
      bundledNode: join(dir, "nope", "runtime", "node.exe"),
      bundledTemplate: join(dir, "nope", "x.template"),
      tempDir: join(dir, "elsewhere"),
      run: f.run,
      fetch: f.fetch,
    });
    await none.ensureRunning();
    expect(none.getState()).toMatchObject({ kind: "stopped", reason: "psyched is not bundled" });

    const b = bundle("attach");
    const g = scheduler();
    g.start();
    const sup = supervisor(b, g);
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({ kind: "running", mode: "taskscheduler" });
    expect(verbs(g.calls)).toEqual(["/Query"]);
  });

  it("without this account's SID it registers nothing (the name would collide)", async () => {
    const b = bundle("nosid");
    const f = scheduler();
    // (The default asks whoami; "" stands for "it named nobody".)
    const sup = supervisor(b, f, { userSid: "" });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({
      kind: "stopped",
      mode: "taskscheduler",
      reason: "Windows did not say which account this is (whoami /user)",
    });
    expect(f.calls).toEqual([]);
  });

  it("asks before taking over another copy's task; no means attach, yes replaces it", async () => {
    const other = bundle("other-copy");
    const mine = bundle("this-copy");
    const otherXml = fillTaskTemplate(bundleTemplate(), {
      psychedDir: other.psyched,
      psycheHome: mine.home,
      userId: "HOST\\ada",
      taskName: TASK,
    });
    for (const answer of [false, true]) {
      const f = scheduler({ registered: otherXml });
      const asked: string[] = [];
      const sup = supervisor(mine, f, {
        confirmTakeover: async (p: string) => {
          asked.push(p);
          return answer;
        },
      });
      await sup.ensureRunning();
      expect(asked).toEqual([other.node]);
      if (answer) {
        expect(taskProgram(f.registered() ?? "")).toBe(mine.node);
        expect(verbs(f.calls)).toContain("/End");
      } else {
        expect(f.registered()).toBe(otherXml);
        expect(sup.getState()).toMatchObject({ kind: "stopped", mode: "taskscheduler" });
      }
    }
  });

  it("Quit entirely ends the task and both pid trees, deletes it, and leaves another copy's alone", async () => {
    const b = bundle("quit");
    const f = scheduler();
    const sup = supervisor(b, f);
    await sup.ensureRunning();
    writeFileSync(join(b.home, "run", SERVICE_PID_FILE), "4100");
    writeFileSync(join(b.home, "run", GATEWAY_PID_FILE), "4200");
    await sup.stopEverything();
    expect(f.registered()).toBeUndefined();
    expect(existsSync(gatewayTaskFile(b.home))).toBe(false);
    const tail = f.calls.slice(-5).map((c) => c.join(" "));
    expect(tail).toEqual([
      `schtasks.exe /End /TN ${TASK}`,
      "taskkill.exe /PID 4100 /T /F",
      "taskkill.exe /PID 4200 /T /F",
      `schtasks.exe /Delete /TN ${TASK} /F`,
      `schtasks.exe /Query /TN ${LEGACY_GATEWAY_TASK} /XML`,
    ]);
    expect(sup.getState()).toEqual({ kind: "stopped", mode: "taskscheduler", reason: "quit" });

    const other = bundle("quit-other");
    const otherXml = fillTaskTemplate(bundleTemplate(), {
      psychedDir: other.psyched,
      psycheHome: join(dir, "quit2"),
      userId: "HOST\\ada",
      taskName: TASK,
    });
    const g = scheduler({ registered: otherXml });
    const quitting = supervisor({ ...b, home: join(dir, "quit2") }, g);
    await quitting.stopEverything();
    expect(g.registered()).toBe(otherXml);
  });

  /** \\Psyche\\Gateway as an earlier version registered it, for `userId` (trigger as a SID). */
  const legacyXml = (b: ReturnType<typeof bundle>, sid: string, userId: string) =>
    fillTaskTemplate(bundleTemplate(), {
      psychedDir: b.psyched,
      psycheHome: b.home,
      userId,
      taskName: LEGACY_GATEWAY_TASK,
    }).replace(/(<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>)[^<]*/, `$1${sid}`);

  it("replaces this account's \\Psyche\\Gateway of an earlier version with the per-user task", async () => {
    const b = bundle("migrate");
    const f = scheduler({ legacy: legacyXml(bundle("migrate"), SID, "HOST\\ada") });
    f.start(); // the old task's Gateway is up
    mkdirSync(join(b.home, "run"), { recursive: true });
    writeFileSync(join(b.home, "run", SERVICE_PID_FILE), "4100");
    const asked: string[] = [];
    const sup = supervisor(b, f, { confirmTakeover: async (p: string) => !!asked.push(p) });
    await sup.ensureRunning();
    // Same runtime: no question; the old task stops, goes, and the new one runs.
    expect(asked).toEqual([]);
    expect(f.legacy()).toBeUndefined();
    expect(taskUri(f.registered() ?? "")).toBe(TASK);
    expect(sup.getState()).toEqual({ kind: "running", mode: "taskscheduler" });
    const order = f.calls
      .filter((c) => c[0] !== "schtasks.exe" || c[1] !== "/Query")
      .map((c) => c.slice(0, 4).join(" "));
    expect(order).toEqual([
      `schtasks.exe /End /TN ${LEGACY_GATEWAY_TASK}`,
      "taskkill.exe /PID 4100 /T",
      `schtasks.exe /Delete /TN ${LEGACY_GATEWAY_TASK}`,
      `schtasks.exe /Create /TN ${TASK}`,
      `schtasks.exe /Run /TN ${TASK}`,
    ]);
  });

  it("leaves another account's \\Psyche\\Gateway alone", async () => {
    const b = bundle("migrate-other");
    const theirs = legacyXml(b, "S-1-5-21-1111111111-2222222222-3333333333-1002", "HOST\\bob");
    const f = scheduler({ legacy: theirs });
    const sup = supervisor(b, f);
    await sup.ensureRunning();
    expect(f.legacy()).toBe(theirs);
    expect(legacyCalls(f.calls)).toEqual(["/Query"]);
    expect(taskUri(f.registered() ?? "")).toBe(TASK);
    await sup.stopEverything();
    expect(f.legacy()).toBe(theirs);
  });

  it("asks before replacing this account's old task when it runs another copy", async () => {
    const other = bundle("migrate-copy-other");
    const mine = bundle("migrate-copy-mine");
    const old = legacyXml(other, SID, "HOST\\ada");
    const f = scheduler({ legacy: old });
    const asked: string[] = [];
    const sup = supervisor(mine, f, {
      confirmTakeover: async (p: string) => {
        asked.push(p);
        return false;
      },
    });
    await sup.ensureRunning();
    expect(asked).toEqual([other.node]);
    expect(f.legacy()).toBe(old);
    expect(f.registered()).toBeUndefined();
  });

  it("passes the vault key file in run\\gateway-service.json, owner-only, and restarts for a change", async () => {
    const b = bundle("vault");
    const f = scheduler();
    let keyFile: string | undefined = join(b.home, "secrets", "vault.key");
    const sup = supervisor(b, f, { vaultKeyFile: async () => keyFile });
    await sup.ensureRunning();
    const cfg = gatewayServiceConfigFile(b.home);
    expect(readFileSync(cfg, "utf8")).toBe(gatewayServiceConfig(keyFile));
    expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({ vaultKeyFile: keyFile });
    expect(privacyOf(cfg)).toBe(OWNER_FILE);
    // Not on the task's command line.
    expect(f.registered()).not.toContain("vault.key");

    // Unchanged: nothing restarts.
    f.calls.length = 0;
    await sup.ensureRunning();
    expect(verbs(f.calls)).toEqual(["/Query", "/Query"]);

    // Another key file: the task restarts so the service host reads it.
    keyFile = join(b.home, "secrets", "other.key");
    f.calls.length = 0;
    await sup.ensureRunning();
    expect(verbs(f.calls)).toEqual(["/Query", "/End", "/Run", "/Query"]);
    expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({ vaultKeyFile: keyFile });

    // No key file (the vault has another slot): the file goes.
    keyFile = undefined;
    await sup.ensureRunning();
    expect(existsSync(cfg)).toBe(false);

    // Quit entirely removes it with the task.
    keyFile = join(b.home, "secrets", "vault.key");
    await sup.ensureRunning();
    expect(existsSync(cfg)).toBe(true);
    await sup.stopEverything();
    expect(existsSync(cfg)).toBe(false);
  });

  it("remote mode starts nothing and never touches the task", async () => {
    const f = scheduler();
    const sup = new TaskSchedulerSupervisor({
      mode: "remote",
      psycheHome: join(dir, "remote"),
      healthUrl: "https://host.example/healthz",
      run: f.run,
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    await sup.ensureRunning();
    await sup.stopEverything();
    expect(f.calls).toEqual([]);
  });
});
