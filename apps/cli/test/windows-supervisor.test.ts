import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import {
  GATEWAY_PID_FILE,
  installedPsychedWin32,
  readTaskXml,
  renderScheduledTaskXml,
  SCHEDULED_TASK,
  SERVICE_HOST_FILE,
  SERVICE_HOST_SCRIPT,
  SERVICE_PID_FILE,
  taskXmlPath,
  windowsUserId,
  winQuote,
  writeTaskXml,
} from "../src/supervisor.ts";
import {
  cleanupTempDirs,
  type ExecScript,
  makeDeps,
  runJson,
  type TestDeps,
  tempDir,
} from "./helpers.ts";

afterEach(() => cleanupTempDirs());

/** The task action's arguments, XML entities decoded (as Task Scheduler reads them). */
function argumentsOf(x: string): string {
  const raw = /<Arguments>([^<]*)<\/Arguments>/.exec(x)?.[1] ?? "";
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const input = {
  node: "C:\\Users\\Me Too\\AppData\\Local\\Psyche\\app-0.3.0\\resources\\psyched\\runtime\\node.exe",
  serviceHost: "C:\\Users\\Me Too\\.psyche\\run\\service-host.mjs",
  program:
    "C:\\Users\\Me Too\\AppData\\Local\\Psyche\\app-0.3.0\\resources\\psyched\\runtime\\node.exe",
  args: ["--max-semi-space-size=4", "C:\\x\\main.mjs"],
  psycheHome: "C:\\Users\\Me Too\\.psyche & <co>",
  userId: "DESK\\me",
};

describe("scheduled task XML (\\Psyche\\Gateway)", () => {
  it("runs the service host headless at logon, for this user only, with no time limit", () => {
    const x = renderScheduledTaskXml(input);
    expect(x.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    expect(x).toContain("<URI>\\Psyche\\Gateway</URI>");
    expect(x).toContain(
      "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>DESK\\me</UserId>",
    );
    expect(x).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(x).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(x).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(x).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(x).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(x).toContain("<Command>%SystemRoot%\\System32\\conhost.exe</Command>");
    expect(argumentsOf(x)).toBe(
      `--headless "${input.node}" "${input.serviceHost}" --home "C:\\Users\\Me Too\\.psyche & <co>" -- "${input.program}" --max-semi-space-size=4 "C:\\x\\main.mjs"`,
    );
    expect(x).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
  });

  it("quotes the way node.exe parses its command line", () => {
    expect(winQuote("--home")).toBe("--home");
    expect(winQuote("{{PSYCHED_DIR}}\\runtime\\node.exe")).toBe(
      '"{{PSYCHED_DIR}}\\runtime\\node.exe"',
    );
    expect(winQuote("C:\\dir\\")).toBe('"C:\\dir"');
    expect(winQuote('a"b')).toBe('"a\\"b"');
    expect(winQuote("")).toBe('""');
  });

  it("round-trips as UTF-16 with a BOM", () => {
    const f = join(tempDir(), "t.xml");
    writeTaskXml(f, renderScheduledTaskXml(input));
    const raw = readFileSync(f);
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe]);
    expect(readTaskXml(f)).toBe(renderScheduledTaskXml(input));
  });

  it("names the user as DOMAIN\\user", () => {
    expect(windowsUserId({ USERDOMAIN: "DESK", USERNAME: "me" })).toBe("DESK\\me");
    expect(windowsUserId({ USERNAME: "me" })).toBe("me");
    expect(() => windowsUserId({})).toThrow(/USERNAME/);
  });
});

describe("the desktop app's psyched on Windows", () => {
  it("is the newest app-<version> of the per-user install", () => {
    const local = tempDir();
    for (const v of ["0.9.0", "0.10.0", "0.10.0-beta1"]) {
      const d = join(local, "Psyche", `app-${v}`, "resources", "psyched");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "psyched.cmd"), "@echo off\r\n");
    }
    expect(installedPsychedWin32({ LOCALAPPDATA: local })).toBe(
      win32.join(local, "Psyche", "app-0.10.0", "resources", "psyched", "psyched.cmd"),
    );
    expect(installedPsychedWin32({ LOCALAPPDATA: tempDir() })).toBeNull();
    expect(installedPsychedWin32({})).toBeNull();
  });
});

describe("service commands on win32 (Task Scheduler)", () => {
  /** A fake psyched bundle (psyched.cmd next to runtime\node.exe and the Gateway bundle). */
  function bundle(): string {
    const dir = join(tempDir(), "psyched");
    mkdirSync(join(dir, "runtime"), { recursive: true });
    mkdirSync(join(dir, "app", "apps", "gateway", "dist"), { recursive: true });
    writeFileSync(join(dir, "runtime", "node.exe"), "MZ");
    writeFileSync(join(dir, "app", "apps", "gateway", "dist", "main.mjs"), "");
    writeFileSync(join(dir, "psyched.cmd"), "@echo off\r\n");
    return join(dir, "psyched.cmd");
  }

  let state = "none";
  const win = (extra: ExecScript = () => undefined) => {
    const program = bundle();
    const deps = makeDeps({
      platform: "win32",
      execScript: (cmd, args) => {
        const r = extra(cmd, args);
        if (r) return r;
        if (cmd === "powershell.exe") return { stdout: `${state}\r\n` };
        if (cmd === "schtasks.exe" && args[0] === "/Create") state = "Ready";
        if (cmd === "schtasks.exe" && args[0] === "/Run") state = "Running";
        if (cmd === "schtasks.exe" && args[0] === "/End") state = "Ready";
        return undefined;
      },
      extraEnv: { PSYCHE_GATEWAY_BIN: program, USERDOMAIN: "DESK", USERNAME: "me" },
    });
    return { program, deps };
  };
  const schtasks = (deps: TestDeps) =>
    deps.execCalls.filter((c) => c.cmd === "schtasks.exe").map((c) => c.args);

  it("start registers \\Psyche\\Gateway from $PSYCHE_HOME\\run and runs it", async () => {
    state = "none";
    const { program, deps } = win();
    const { code, json } = await runJson(["start", "--no-wait"], deps);
    expect(code).toBe(0);
    expect(json).toMatchObject({ started: true, file: SCHEDULED_TASK, program });
    const xmlFile = taskXmlPath(deps.home);
    expect(schtasks(deps)).toEqual([
      ["/Create", "/TN", SCHEDULED_TASK, "/XML", xmlFile, "/F"],
      ["/Run", "/TN", SCHEDULED_TASK],
    ]);
    const xml = argumentsOf(readTaskXml(xmlFile) ?? "");
    const dir = join(program, "..");
    // The bundle's own node.exe runs the Gateway directly: no cmd.exe in between.
    expect(xml).toContain(`-- "${join(dir, "runtime", "node.exe")}" --max-semi-space-size=4`);
    expect(xml).toContain(`"${join(dir, "app", "apps", "gateway", "dist", "main.mjs")}"`);
    expect(readFileSync(join(deps.home, "run", SERVICE_HOST_FILE), "utf8")).toBe(
      SERVICE_HOST_SCRIPT,
    );
    expect(existsSync(join(deps.home, "logs"))).toBe(true);

    // Running and unchanged: nothing to do.
    deps.execCalls.length = 0;
    expect((await runJson(["start", "--no-wait"], deps)).code).toBe(0);
    expect(schtasks(deps)).toEqual([]);
  });

  it("stop ends the task and the service host's process tree; status reads the task state", async () => {
    state = "Running";
    const { deps } = win();
    mkdirSync(join(deps.home, "run"), { recursive: true });
    writeFileSync(join(deps.home, "run", SERVICE_PID_FILE), "4242");
    writeFileSync(join(deps.home, "run", GATEWAY_PID_FILE), "4343");
    const st = await runJson(["status", "--url", "http://127.0.0.1:1"], deps);
    expect(st.json.service).toMatchObject({
      kind: "taskscheduler",
      installed: true,
      running: true,
      pid: 4343,
      file: SCHEDULED_TASK,
    });
    deps.execCalls.length = 0;
    await run(["stop", "--url", "http://127.0.0.1:1"], deps);
    expect(
      deps.execCalls.map((c) => [c.cmd, ...c.args]).filter((c) => c[0] !== "powershell.exe"),
    ).toEqual([
      ["schtasks.exe", "/End", "/TN", SCHEDULED_TASK],
      ["taskkill.exe", "/PID", "4242", "/T", "/F"],
      ["taskkill.exe", "/PID", "4343", "/T", "/F"],
    ]);
  });

  it("stop with no task installed is a no-op; restart says to run psyche start", async () => {
    state = "none";
    const { deps } = win();
    await run(["stop", "--url", "http://127.0.0.1:1"], deps);
    expect(schtasks(deps)).toEqual([]);
    expect(await run(["restart", "--url", "http://127.0.0.1:1"], deps)).toBe(1);
  });

  it("finds psyched with where.exe, skipping the extensionless sh shim", async () => {
    state = "none";
    const program = bundle();
    const deps = makeDeps({
      platform: "win32",
      extraEnv: { USERDOMAIN: "DESK", USERNAME: "me", LOCALAPPDATA: tempDir() },
      execScript: (cmd, args) =>
        cmd === "where.exe" && args[0] === "psyched"
          ? { stdout: `${program.replace(/\.cmd$/, "")}\r\n${program}\r\n` }
          : cmd === "powershell.exe"
            ? { stdout: "none\r\n" }
            : undefined,
    });
    const { code, json } = await runJson(["start", "--no-wait"], deps);
    expect(code).toBe(0);
    expect(json.program).toBe(program);
  });
});

describe("SERVICE_HOST_SCRIPT", () => {
  it("sets PSYCHE_HOME, appends both logs, records pids and restarts the program when it exits", async () => {
    const dir = tempDir();
    const home = join(dir, "home dir");
    const host = join(dir, SERVICE_HOST_FILE);
    writeFileSync(host, SERVICE_HOST_SCRIPT);
    const prog = join(dir, "prog.mjs");
    writeFileSync(
      prog,
      'console.log("home=" + process.env.PSYCHE_HOME); console.error("err line"); setTimeout(() => process.exit(1), 50);',
    );
    const child = spawn(process.execPath, [host, "--home", home, "--", process.execPath, prog], {
      stdio: "ignore",
    });
    const out = join(home, "logs", "gateway.out.log");
    const deadline = Date.now() + 15_000;
    let text = "";
    while (Date.now() < deadline) {
      text = existsSync(out) ? readFileSync(out, "utf8") : "";
      if (text.split("home=").length > 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(Number(readFileSync(join(home, "run", SERVICE_PID_FILE), "utf8"))).toBe(child.pid);
    expect(existsSync(join(home, "run", GATEWAY_PID_FILE))).toBe(true);
    child.kill();
    await new Promise((r) => child.once("exit", r));
    // Started at least twice (the first run exited 1), each time with PSYCHE_HOME.
    expect(text.split(`home=${home}`).length).toBeGreaterThan(2);
    expect(readFileSync(join(home, "logs", "gateway.err.log"), "utf8")).toContain("err line");
  }, 20_000);

  it("refuses a command line without --home and --", async () => {
    const dir = tempDir();
    const host = join(dir, SERVICE_HOST_FILE);
    writeFileSync(host, SERVICE_HOST_SCRIPT);
    const code = await new Promise<number | null>((r) =>
      spawn(process.execPath, [host, "prog"], { stdio: "ignore" }).once("exit", r),
    );
    expect(code).toBe(64);
  });
});
