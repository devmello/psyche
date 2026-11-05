import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderScheduledTaskXml, writeTaskXml } from "../../../cli/src/supervisor.ts";
import { chooseMode, devGatewayCommand, type Runner } from "../../src/main/supervisor.ts";
import {
  bundledGatewayPaths,
  decodeTaskXml,
  encodeTaskXml,
  fillTaskTemplate,
  GATEWAY_PID_FILE,
  gatewayTaskFile,
  isTemporaryLocation,
  parseCsvRow,
  parseLastResult,
  quoteWindowsArg,
  SCHEDULED_TASK,
  SERVICE_PID_FILE,
  schtasks,
  splitWindowsArgs,
  TaskSchedulerSupervisor,
  taskProgram,
  windowsUserId,
} from "../../src/main/supervisor-windows.ts";

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

  it("uses the CLI's task, \\Psyche\\Gateway", () => {
    expect(SCHEDULED_TASK).toBe("\\Psyche\\Gateway");
    expect(schtasks.create("C:\\h\\run\\psyche-gateway.task.xml")).toEqual([
      "/Create",
      "/TN",
      "\\Psyche\\Gateway",
      "/XML",
      "C:\\h\\run\\psyche-gateway.task.xml",
      "/F",
    ]);
    expect(schtasks.end()).toEqual(["/End", "/TN", "\\Psyche\\Gateway"]);
    expect(schtasks.delete()).toEqual(["/Delete", "/TN", "\\Psyche\\Gateway", "/F"]);
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
  };
  const xml = fillTaskTemplate(bundleTemplate(), values);

  it("fills every placeholder, XML-escaped, and reads back the runtime it runs", () => {
    expect(xml).not.toContain("{{");
    expect(xml).toContain("<UserId>HOST\\Ada</UserId>");
    expect(xml).not.toContain("Ada & Co");
    expect(taskProgram(xml)).toBe(`${values.psychedDir}\\runtime\\node.exe`);
    expect(xml).toContain("<URI>\\Psyche\\Gateway</URI>");
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

/** A fake Task Scheduler and taskkill: registered after /Create, healthy once run. */
function scheduler(o: { neverHealthy?: boolean; registered?: string } = {}) {
  const calls: string[][] = [];
  let registered = o.registered;
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
    if (verb === "/Create") registered = decodeTaskXml(readFileSync(args[4] as string));
    if (verb === "/Delete") registered = undefined;
    if (verb === "/Run") running = registered !== undefined;
    if (verb === "/Query") {
      if (registered === undefined) return { code: 1, stdout: "", stderr: "not found" };
      if (args.includes("/XML")) return { code: 0, stdout: registered, stderr: "" };
      if (args.includes("/V"))
        return { code: 0, stdout: '"H","\\Psyche\\Gateway","N/A","Ready","I","x","3"', stderr: "" };
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
    registered: () => registered,
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
    calls.filter((c) => c[0] === "schtasks.exe").map((c) => c[1]);

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

  it("asks before taking over another copy's task; no means attach, yes replaces it", async () => {
    const other = bundle("other-copy");
    const mine = bundle("this-copy");
    const otherXml = fillTaskTemplate(bundleTemplate(), {
      psychedDir: other.psyched,
      psycheHome: mine.home,
      userId: "HOST\\ada",
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
    const tail = f.calls.slice(-4).map((c) => c.join(" "));
    expect(tail).toEqual([
      "schtasks.exe /End /TN \\Psyche\\Gateway",
      "taskkill.exe /PID 4100 /T /F",
      "taskkill.exe /PID 4200 /T /F",
      "schtasks.exe /Delete /TN \\Psyche\\Gateway /F",
    ]);
    expect(sup.getState()).toEqual({ kind: "stopped", mode: "taskscheduler", reason: "quit" });

    const other = bundle("quit-other");
    const otherXml = fillTaskTemplate(bundleTemplate(), {
      psychedDir: other.psyched,
      psycheHome: join(dir, "quit2"),
      userId: "HOST\\ada",
    });
    const g = scheduler({ registered: otherXml });
    const quitting = supervisor({ ...b, home: join(dir, "quit2") }, g);
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
