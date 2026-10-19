import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getRun, getThread, getToolCall, listAllMessages } from "@psyche/db";
import type { Thread } from "@psyche/protocol";
import { FakeAgentLoop } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { RESTART_ERROR } from "../src/recovery.ts";
import {
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
} from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const FIXTURE = resolve(import.meta.dirname, "fixtures/crash-gateway.ts");

let child: ChildProcess | null = null;
let t: TestGateway | null = null;
let home = "";

afterEach(async () => {
  child?.kill("SIGKILL");
  await t?.cleanup();
  if (home) rmSync(home, { recursive: true, force: true });
});

function startChild(dir: string): Promise<{ port: number; secret: string }> {
  return new Promise((resolveReady, reject) => {
    // `node --import tsx` (not the tsx binary, which forks) so SIGKILL hits the Gateway itself.
    child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
      cwd: ROOT,
      env: { ...process.env, PSYCHE_HOME: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
      const m = /READY (\d+) (\S+)/.exec(out);
      if (m) resolveReady({ port: Number(m[1]), secret: String(m[2]) });
    });
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    child.once("exit", (code) => reject(new Error(`child exited ${code}: ${err}`)));
  });
}

describe("restart mid-turn", () => {
  it("leaves a consistent transcript and duplicates no side effect after a SIGKILL between model events", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-crash-"));
    const { port, secret } = await startChild(home);
    const origin = `http://127.0.0.1:${port}`;
    const key = newDeviceKey();
    const c = await TestClient.open(`ws://127.0.0.1:${port}/ws`);
    await handshake(c, origin, { key, deviceId: "desk", handshakeSecret: secret });
    const thread = (await c.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik()))
      .thread;
    const sendKey = ik();
    const sent = await c.call<{ messageId: string; runId: string }>(
      "chat.send",
      { threadId: thread.id, content: "write my notes" },
      sendKey,
    );
    await c.waitForEvent((e) => e.event === "tool_call.updated");
    child?.kill("SIGKILL");
    await new Promise((r) => child?.once("exit", r));
    child = null;
    c.close();

    const agent = new FakeAgentLoop();
    t = await startTestGateway({
      home,
      agent,
      config: { dbPath: join(home, "state", "psyche.sqlite") },
    });
    const db = t.gateway.context.db;
    expect(t.gateway.recovery.failedRuns).toEqual([sent.runId]);
    expect(getRun(db, sent.runId)).toMatchObject({ status: "failed", error: RESTART_ERROR });
    expect(getToolCall(db, `tc_${sent.runId}`)?.status).toBe("uncertain");
    expect(getThread(db, thread.id)?.activeWriterRunId ?? null).toBeNull();
    const messages = listAllMessages(db, thread.id);
    expect(messages.map((m) => [m.role, m.seq])).toEqual([
      ["user", 1],
      ["system", 2],
    ]);
    expect(messages[0]?.id).toBe(sent.messageId);

    // A client retrying the same request after the restart gets the original result: no new
    // message, no new run, nothing re-dispatched.
    const again = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    const res = await handshake(again, t.gateway.origin, { key, deviceId: "desk" });
    expect(verified<{ phase: string }>(res).phase).toBe("paired");
    const replay = await again.call(
      "chat.send",
      { threadId: thread.id, content: "write my notes" },
      sendKey,
    );
    expect(replay).toEqual(sent);
    await t.gateway.context.sessions.idle();
    expect(agent.turns).toHaveLength(0);
    expect(listAllMessages(db, thread.id)).toHaveLength(2);

    // The thread is usable again.
    await again.call("chat.send", { threadId: thread.id, content: "try again" }, ik());
    await t.gateway.context.sessions.idle();
    expect(agent.turns).toHaveLength(1);
    again.close();
  }, 30_000);
});
