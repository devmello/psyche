import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chooseMode, devGatewayCommand, type Runner } from "../../src/main/supervisor.ts";
import {
  bundledGatewayPaths,
  dataModuleUrl,
  decodeTaskXml,
  encodeTaskXml,
  gatewayPreloadSource,
  gatewayTaskArgs,
  gatewayTaskFile,
  gatewayTaskName,
  isTemporaryLocation,
  killGatewayScript,
  parseCsvRow,
  parseLastResult,
  parseWhoami,
  quoteWindowsArg,
  renderGatewayTaskXml,
  schtasks,
  splitWindowsArgs,
  TaskSchedulerSupervisor,
  taskProgram,
} from "../../src/main/supervisor-windows.ts";

const dir = mkdtempSync(join(tmpdir(), "psy-wsup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SID = "S-1-5-21-1825757875-3616296202-2718152036-1001";
const input = {
  node: "C:\\Users\\Ada Lovelace\\AppData\\Local\\Psyche\\app-0.3.0\\resources\\psyched\\runtime\\node.exe",
  entry:
    "C:\\Users\\Ada Lovelace\\AppData\\Local\\Psyche\\app-0.3.0\\resources\\psyched\\app\\apps\\gateway\\dist\\main.mjs",
  psycheHome: "C:\\Users\\Ada Lovelace\\.psyche",
  logDir: "C:\\Users\\Ada Lovelace\\.psyche\\logs",
  sid: SID,
  systemRoot: "C:\\Windows",
};

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

  it("finds the bundled runtime and Gateway entry in the packaged resources", () => {
    expect(bundledGatewayPaths("C:\\P\\resources")).toEqual({
      node: join("C:\\P\\resources", "psyched", "runtime", "node.exe"),
      entry: join("C:\\P\\resources", "psyched", "app", "apps", "gateway", "dist", "main.mjs"),
    });
  });
});

describe("Windows command lines", () => {
  it("quotes like CommandLineToArgvW and splits back to the same argv", () => {
    const args = [
      "plain",
      "with space",
      "C:\\dir with space\\",
      'quote"inside',
      "",
      "back\\\\slashes\\",
    ];
    const line = args.map(quoteWindowsArg).join(" ");
    expect(splitWindowsArgs(line)).toEqual(args);
    expect(quoteWindowsArg("C:\\Program Files\\x.exe")).toBe('"C:\\Program Files\\x.exe"');
    expect(quoteWindowsArg("--headless")).toBe("--headless");
  });

  it("reads whoami's SID and schtasks' CSV in any language (by column)", () => {
    expect(parseWhoami(`"devmello\\pranav","${SID}"\r\n`)).toEqual({
      user: "devmello\\pranav",
      sid: SID,
    });
    expect(parseWhoami("nonsense")).toBeUndefined();
    expect(parseCsvRow('"a","b ""q""",c')).toEqual(["a", 'b "q"', "c"]);
    const row =
      '"HOST","\\Psyche Gateway-S-1","N/A","Wird ausgeführt","Nur interaktiv","05.11.2026","1","N/A","C:\\x"';
    expect(parseLastResult(row)).toBe("1");
    expect(parseLastResult("")).toBeUndefined();
  });

  it("names the task per user and builds the schtasks argv", () => {
    expect(gatewayTaskName(SID)).toBe(`Psyche Gateway-${SID}`);
    const n = gatewayTaskName(SID);
    expect(schtasks.create(n, "C:\\h\\run\\gateway-task.xml")).toEqual([
      "/create",
      "/tn",
      n,
      "/xml",
      "C:\\h\\run\\gateway-task.xml",
      "/f",
    ]);
    expect(schtasks.run(n)).toEqual(["/run", "/tn", n]);
    expect(schtasks.end(n)).toEqual(["/end", "/tn", n]);
    expect(schtasks.delete(n)).toEqual(["/delete", "/tn", n, "/f"]);
    expect(schtasks.queryVerbose(n)).toEqual(["/query", "/tn", n, "/v", "/fo", "csv", "/nh"]);
  });

  it("passes a path with a quote safely to PowerShell's kill backstop", () => {
    expect(killGatewayScript("C:\\it's\\main.mjs")).toContain("$e='C:\\it''s\\main.mjs'");
  });

  it("never registers a runtime inside the temp folder (an exe run from inside a ZIP)", () => {
    expect(isTemporaryLocation(join(tmpdir(), "Temp1_psyche.zip", "node.exe"))).toBe(true);
    expect(
      isTemporaryLocation(join(dir, "..", "..", "elsewhere", "node.exe"), join(dir, "t")),
    ).toBe(false);
  });
});

describe("the Gateway's scheduled task", () => {
  const xml = renderGatewayTaskXml({ ...input, env: { PSYCHE_VAULT_KEY_FILE: "C:\\k&<x>" } });

  it("runs at logon and on registration, every minute it is not running, hidden, for this user", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toMatch(/<LogonTrigger>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<\/LogonTrigger>/);
    expect(xml).toMatch(/<LogonTrigger>[\s\S]*<UserId>S-1-5-21-[\d-]+<\/UserId>/);
    expect(xml).toMatch(/<RegistrationTrigger>[\s\S]*PT1M[\s\S]*<\/RegistrationTrigger>/);
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>/);
    expect(xml).toContain(`<URI>\\Psyche Gateway-${SID}</URI>`);
  });

  it("runs the bundled node under a headless conhost, the preload first, the Gateway last", () => {
    expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
    const args = gatewayTaskArgs(input);
    expect(args[0]).toBe("--headless");
    expect(args[1]).toBe(input.node);
    expect(args[2]).toBe("--import");
    expect(args[3]).toMatch(/^data:text\/javascript,[A-Za-z0-9%._-]+$/);
    expect(args[4]).toBe(input.entry);
    // The XML holds the escaped command line, which reads back to the same runtime.
    expect(taskProgram(xml)).toBe(input.node);
    expect(xml).not.toContain("k&<x>");
  });

  it("sets the environment and the log files, and stops with its conhost", () => {
    const src = gatewayPreloadSource({
      env: { PSYCHE_HOME: input.psycheHome, PSYCHE_VAULT_KEY_FILE: "C:\\k" },
      logDir: input.logDir,
    });
    expect(src).toContain(
      JSON.stringify({ PSYCHE_HOME: input.psycheHome, PSYCHE_VAULT_KEY_FILE: "C:\\k" }),
    );
    expect(src).toContain('"gateway.out.log"');
    expect(src).toContain('"gateway.err.log"');
    expect(src).toContain('process.emit("SIGTERM")');
    // The data URL decodes to exactly that module.
    const url = dataModuleUrl(src);
    expect(decodeURIComponent(url.slice("data:text/javascript,".length))).toBe(src);
  });

  it("round-trips through the UTF-16 file schtasks reads", () => {
    const buf = encodeTaskXml(xml);
    expect([buf[0], buf[1]]).toEqual([0xff, 0xfe]);
    expect(decodeTaskXml(buf)).toBe(xml);
  });

  it("the preload really sets the environment and appends both logs", async () => {
    const logDir = join(dir, "preload-logs");
    const src = gatewayPreloadSource({ env: { PSYCHE_PRELOAD_TEST: "yes" }, logDir });
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(
      process.execPath,
      [
        "--import",
        dataModuleUrl(src),
        "-e",
        "console.log('out', process.env.PSYCHE_PRELOAD_TEST); console.error('err line')",
      ],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(readFileSync(join(logDir, "gateway.out.log"), "utf8")).toBe("out yes\n");
    expect(readFileSync(join(logDir, "gateway.err.log"), "utf8")).toBe("err line\n");
  });
});

/** A fake Task Scheduler: registered after /create, healthy once run (unless told otherwise). */
function scheduler(o: { neverHealthy?: boolean; registered?: string } = {}) {
  const calls: string[][] = [];
  let registered = o.registered;
  let running = false;
  const run: Runner = async (file, args) => {
    calls.push([file.split("\\").pop() ?? file, ...args]);
    const exe = file.toLowerCase();
    if (exe.endsWith("whoami.exe")) return { code: 0, stdout: `"h\\u","${SID}"`, stderr: "" };
    if (!exe.endsWith("schtasks.exe")) return { code: 0, stdout: "", stderr: "" };
    const verb = args[0];
    if (verb === "/create") {
      registered = decodeTaskXml(readFileSync(args[4] as string));
      running = true;
    }
    if (verb === "/delete") registered = undefined;
    if (verb === "/end") running = false;
    if (verb === "/run") running = registered !== undefined;
    if (verb === "/query") {
      if (registered === undefined) return { code: 1, stdout: "", stderr: "not found" };
      if (args.includes("/xml")) return { code: 0, stdout: registered, stderr: "" };
      if (args.includes("/v"))
        return { code: 0, stdout: '"H","\\T","N/A","Ready","I","x","3"', stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchFn: typeof fetch = () =>
    running && !o.neverHealthy
      ? Promise.resolve(new Response("{}", { status: 200 }))
      : Promise.reject(new Error("down"));
  return { calls, run, fetch: fetchFn, registered: () => registered };
}

function bundle(name: string): { node: string; entry: string; home: string } {
  const root = join(dir, name);
  const node = join(root, "psyched", "runtime", "node.exe");
  const entry = join(root, "psyched", "app", "apps", "gateway", "dist", "main.mjs");
  mkdirSync(join(root, "psyched", "runtime"), { recursive: true });
  mkdirSync(join(root, "psyched", "app", "apps", "gateway", "dist"), { recursive: true });
  writeFileSync(node, "");
  writeFileSync(entry, "");
  return { node, entry, home: join(root, "home") };
}

describe("TaskSchedulerSupervisor", () => {
  const verbs = (calls: string[][]) =>
    calls.filter((c) => c[0] === "schtasks.exe").map((c) => c[1]);

  it("registers the task, runs it and waits for /healthz; a second launch changes nothing", async () => {
    const b = bundle("fresh");
    const f = scheduler();
    const states: string[] = [];
    const sup = new TaskSchedulerSupervisor({
      mode: "taskscheduler",
      // The test bundles live in the temp folder, which a real install never does.
      tempDir: join(dir, "elsewhere"),
      psycheHome: b.home,
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledNode: b.node,
      bundledEntry: b.entry,
      systemRoot: "C:\\Windows",
      vaultKeyFile: () => join(b.home, "secrets", "vault.key"),
      run: f.run,
      fetch: f.fetch,
      sleep: async () => undefined,
      onState: (s) => states.push(`${s.kind}${"step" in s && s.step ? `:${s.step}` : ""}`),
    });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({ kind: "running", mode: "taskscheduler" });
    expect(verbs(f.calls)).toEqual(["/query", "/create", "/run", "/query"]);
    expect(states).toEqual(["starting:installing", "starting:waiting", "running"]);
    const stored = decodeTaskXml(readFileSync(gatewayTaskFile(b.home)));
    expect(stored).toBe(f.registered());
    expect(stored).toContain("PSYCHE_VAULT_KEY_FILE");
    expect(existsSync(join(b.home, "logs"))).toBe(true);

    f.calls.length = 0;
    await sup.ensureRunning();
    expect(verbs(f.calls)).toEqual(["/query", "/query"]);
  });

  it("reports a Gateway that never answers with the task's last result and the logs folder", async () => {
    const b = bundle("silent");
    const f = scheduler({ neverHealthy: true });
    const sup = new TaskSchedulerSupervisor({
      mode: "taskscheduler",
      // The test bundles live in the temp folder, which a real install never does.
      tempDir: join(dir, "elsewhere"),
      psycheHome: b.home,
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledNode: b.node,
      bundledEntry: b.entry,
      run: f.run,
      fetch: f.fetch,
      healthTimeoutMs: 0,
      sleep: async () => undefined,
    });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({
      kind: "stopped",
      mode: "taskscheduler",
      reason: "The Gateway did not answer within 0 s (last exit code 3)",
      logs: join(b.home, "logs"),
    });
    expect(verbs(f.calls)).toContain("/run");
  });

  it("says when no Gateway is bundled, and attaches to one it did not start", async () => {
    const none = new TaskSchedulerSupervisor({
      mode: "taskscheduler",
      // The test bundles live in the temp folder, which a real install never does.
      tempDir: join(dir, "elsewhere"),
      psycheHome: join(dir, "nobundle"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledNode: join(dir, "nope", "node.exe"),
      bundledEntry: join(dir, "nope", "main.mjs"),
      run: scheduler().run,
      fetch: () => Promise.reject(new Error("down")),
    });
    await none.ensureRunning();
    expect(none.getState()).toMatchObject({ kind: "stopped", reason: "psyched is not bundled" });

    const b = bundle("attach");
    const f = scheduler();
    const sup = new TaskSchedulerSupervisor({
      mode: "taskscheduler",
      // The test bundles live in the temp folder, which a real install never does.
      tempDir: join(dir, "elsewhere"),
      psycheHome: b.home,
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledNode: b.node,
      bundledEntry: b.entry,
      run: f.run,
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({ kind: "running", mode: "taskscheduler" });
    expect(verbs(f.calls)).toEqual(["/query"]);
  });

  it("asks before taking over another copy's task; no means attach, yes replaces it", async () => {
    const other = bundle("other-copy");
    const mine = bundle("this-copy");
    const otherXml = renderGatewayTaskXml({
      node: other.node,
      entry: other.entry,
      psycheHome: mine.home,
      logDir: join(mine.home, "logs"),
      sid: SID,
    });
    for (const answer of [false, true]) {
      const f = scheduler({ registered: otherXml });
      const asked: string[] = [];
      const sup = new TaskSchedulerSupervisor({
        mode: "taskscheduler",
        // The test bundles live in the temp folder, which a real install never does.
        tempDir: join(dir, "elsewhere"),
        psycheHome: mine.home,
        healthUrl: "http://127.0.0.1:1/healthz",
        bundledNode: mine.node,
        bundledEntry: mine.entry,
        run: f.run,
        fetch: f.fetch,
        sleep: async () => undefined,
        confirmTakeover: async (p) => {
          asked.push(p);
          return answer;
        },
      });
      await sup.ensureRunning();
      expect(asked).toEqual([other.node]);
      if (answer) {
        expect(taskProgram(f.registered() ?? "")).toBe(mine.node);
        // The other copy's running Gateway was ended first.
        expect(verbs(f.calls)).toContain("/end");
      } else {
        expect(f.registered()).toBe(otherXml);
        expect(sup.getState()).toMatchObject({ kind: "stopped", mode: "taskscheduler" });
      }
    }
  });

  it("Quit entirely ends and deletes its own task, and leaves another copy's alone", async () => {
    const b = bundle("quit");
    const f = scheduler();
    const sup = new TaskSchedulerSupervisor({
      mode: "taskscheduler",
      // The test bundles live in the temp folder, which a real install never does.
      tempDir: join(dir, "elsewhere"),
      psycheHome: b.home,
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledNode: b.node,
      bundledEntry: b.entry,
      run: f.run,
      fetch: f.fetch,
      sleep: async () => undefined,
    });
    await sup.ensureRunning();
    await sup.stopEverything();
    expect(f.registered()).toBeUndefined();
    expect(existsSync(gatewayTaskFile(b.home))).toBe(false);
    expect(verbs(f.calls).slice(-3)).toEqual(["/query", "/end", "/delete"]);
    expect(sup.getState()).toEqual({ kind: "stopped", mode: "taskscheduler", reason: "quit" });

    const other = bundle("quit-other");
    const otherXml = renderGatewayTaskXml({
      node: other.node,
      entry: other.entry,
      psycheHome: b.home,
      logDir: join(b.home, "logs"),
      sid: SID,
    });
    const g = scheduler({ registered: otherXml });
    const quitting = new TaskSchedulerSupervisor({
      mode: "taskscheduler",
      // The test bundles live in the temp folder, which a real install never does.
      tempDir: join(dir, "elsewhere"),
      psycheHome: b.home,
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledNode: b.node,
      bundledEntry: b.entry,
      run: g.run,
      fetch: g.fetch,
    });
    await quitting.stopEverything();
    expect(g.registered()).toBe(otherXml);
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
