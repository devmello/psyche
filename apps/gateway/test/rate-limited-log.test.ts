import { describe, expect, it } from "vitest";
import type { Logger, LogLevel } from "../src/log.ts";
import { RateLimitedLog, type WindowScheduler } from "../src/rate-limited-log.ts";
import { startTestGateway, TestClient } from "./helpers.ts";

interface Line {
  level: LogLevel;
  msg: string;
  fields?: Record<string, string | number | boolean | null>;
}

/** A logger that records lines, a fake clock, and a scheduler that only runs when told to. */
function harness() {
  const lines: Line[] = [];
  let now = 1_000_000;
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const schedule: WindowScheduler = (fn, ms) => {
    pending.push({ fn, ms });
  };
  return {
    lines,
    pending,
    clock: {
      now: () => now,
      advance(ms: number) {
        now += ms;
      },
    },
    schedule,
  };
}

describe("RateLimitedLog", () => {
  it("logs the first rejection, counts the rest, and emits one summary per window", () => {
    const h = harness();
    const log = new RateLimitedLog(logger(h.lines), "rejected", {
      now: h.clock.now,
      schedule: h.schedule,
    });
    for (let i = 0; i < 50; i += 1) {
      h.clock.advance(1000); // 50 attempts over 50 seconds, all inside one minute
      log.warn({ hasOrigin: true });
    }
    expect(h.lines).toEqual([{ level: "warn", msg: "rejected", fields: { hasOrigin: true } }]);
    // The window closes after a minute: one summary carrying the 49 held-back repeats.
    expect(h.pending.map((p) => p.ms)).toEqual([60_000]);
    h.pending[0]?.fn();
    expect(h.lines.at(-1)).toEqual({
      level: "warn",
      msg: "rejected (repeats suppressed)",
      fields: { suppressed: 49 },
    });
    expect(h.lines).toHaveLength(2);
  });

  it("starts a new window on the next attempt after a minute, logging again", () => {
    const h = harness();
    const log = new RateLimitedLog(logger(h.lines), "rejected", {
      now: h.clock.now,
      schedule: h.schedule,
    });
    log.warn();
    log.warn();
    log.warn();
    h.clock.advance(60_000);
    log.warn({ hasOrigin: true });
    expect(h.lines.map((l) => l.msg)).toEqual([
      "rejected",
      "rejected (repeats suppressed)",
      "rejected",
    ]);
    expect(h.lines[1]?.fields).toEqual({ suppressed: 2 });
  });

  it("emits the summary on the next attempt when the window timer has not fired yet", () => {
    const h = harness();
    const log = new RateLimitedLog(logger(h.lines), "rejected", {
      now: h.clock.now,
      schedule: () => undefined,
    });
    log.warn();
    log.warn();
    h.clock.advance(60_000);
    log.warn();
    expect(h.lines.map((l) => [l.msg, l.fields])).toEqual([
      ["rejected", {}],
      ["rejected (repeats suppressed)", { suppressed: 1 }],
      ["rejected", {}],
    ]);
  });
});

describe("Gateway upgrade rejections", () => {
  it("refuses every Origin-carrying upgrade with 403 and logs them rate-limited", async () => {
    const lines: Line[] = [];
    const logger: Logger = {
      log(level, msg, fields) {
        lines.push({ level, msg, fields });
      },
    };
    const t = await startTestGateway({ logger });
    try {
      const wsUrl = `ws://127.0.0.1:${t.gateway.port}/ws`;
      for (let i = 0; i < 20; i += 1) {
        await expect(TestClient.open(wsUrl, { origin: "https://evil.example" })).rejects.toThrow(
          "403",
        );
      }
      const rejected = lines.filter((l) => l.msg === "websocket upgrade rejected");
      expect(rejected).toEqual([
        {
          level: "warn",
          msg: "websocket upgrade rejected",
          fields: { path: "/ws", hasOrigin: true },
        },
      ]);
    } finally {
      await t.cleanup();
    }
  });
});

function logger(lines: Line[]): Logger {
  return {
    log(level, msg, fields) {
      lines.push({ level, msg, fields });
    },
  };
}
