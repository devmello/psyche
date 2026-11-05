import { PsycheError, type SpeechEngine } from "@psyche/protocol";
import { FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { PCM_16K_MONO } from "../src/audio.ts";
import {
  DEFAULT_SPEECH_SETTINGS,
  defaultSpeechSettings,
  type EngineEntry,
  parseSttOrder,
  RoutedSpeechEngine,
  SpeechEngineSelector,
} from "../src/policy.ts";

function entry(
  id: string,
  location: EngineEntry["location"],
  opts: { up?: boolean; engine?: SpeechEngine; stream?: boolean } = {},
): EngineEntry {
  const e: EngineEntry = {
    id,
    location,
    supports: { transcribe: true, stream: opts.stream ?? true },
    available: async () => opts.up ?? true,
  };
  if (location !== "client") e.engine = opts.engine ?? new FakeSpeechEngine();
  return e;
}

function selector(up: { mac?: boolean; whisper?: boolean } = {}) {
  return new SpeechEngineSelector()
    .register(entry("mac-node", "node", { up: up.mac ?? true }))
    .register(entry("whisper", "gateway", { up: up.whisper ?? true }))
    .register(entry("web-speech", "client"));
}

describe("engine selection policy (Q1, ADR-014)", () => {
  it("prefers the Mac node, then whisper.cpp, then Web Speech", async () => {
    expect((await selector().select({ purpose: "dictation", caller: "desktop" })).id).toBe(
      "mac-node",
    );
    expect(
      (await selector({ mac: false }).select({ purpose: "dictation", caller: "desktop" })).id,
    ).toBe("whisper");
    const web = await selector({ mac: false, whisper: false }).select({
      purpose: "dictation",
      caller: "web",
    });
    expect(web).toMatchObject({ id: "web-speech", location: "client" });
    expect(web.engine).toBeUndefined();
  });

  it("never hands a client-only engine to the desktop, a channel or the agent", async () => {
    const s = selector({ mac: false, whisper: false });
    for (const caller of ["desktop", "channel", "agent"] as const) {
      const err = await s.select({ purpose: "dictation", caller }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PsycheError);
      expect((err as PsycheError).code).toBe("unavailable");
    }
    const explain = await s.explain({ purpose: "dictation", caller: "desktop" });
    expect(explain.map((e) => [e.id, e.reason])).toEqual([
      ["mac-node", "unavailable"],
      ["whisper", "unavailable"],
      ["web-speech", "client_only"],
    ]);
  });

  it("treats a throwing availability probe as unavailable", async () => {
    const s = new SpeechEngineSelector().register({
      ...entry("whisper", "gateway"),
      available: async () => {
        throw new Error("boom");
      },
    });
    await expect(s.select({ purpose: "file" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("follows the configured order and skips unknown ids", async () => {
    const s = selector();
    s.configure({ ...DEFAULT_SPEECH_SETTINGS, stt: { order: ["nope", "whisper", "mac-node"] } });
    expect((await s.select({ purpose: "file" })).id).toBe("whisper");
  });

  it("rejects a server-side entry without an engine", () => {
    expect(() =>
      new SpeechEngineSelector().register({
        id: "x",
        location: "gateway",
        supports: { transcribe: true, stream: true },
        available: async () => true,
      }),
    ).toThrow(PsycheError);
  });
});

describe("RoutedSpeechEngine", () => {
  it("routes per call and applies the language and vocabulary settings", async () => {
    const seen: unknown[] = [];
    const whisper = new FakeSpeechEngine().transcript("call alice");
    const spy: SpeechEngine = {
      capabilities: () => whisper.capabilities(),
      transcribeStream: (a, f, o) => whisper.transcribeStream(a, f, o),
      transcribeFile: async (d, f, o) => {
        seen.push(o);
        return whisper.transcribeFile(d, f, o);
      },
    };
    const s = new SpeechEngineSelector({
      stt: { order: ["whisper"], language: "en-US", vocabulary: ["Pip"] },
    }).register(entry("whisper", "gateway", { engine: spy }));
    const routed = new RoutedSpeechEngine(s);
    const t = await routed.transcribeFile(new Uint8Array(320), PCM_16K_MONO, {
      vocabulary: ["Alice"],
    });
    expect(t.text).toBe("call alice");
    expect(seen[0]).toMatchObject({ language: "en-US", vocabulary: ["Alice", "Pip"] });
    const caps = await routed.capabilities();
    expect(caps).toMatchObject({ streaming: true });
  });
});

describe("the default order per host (Windows prefers whisper.cpp over SAPI)", () => {
  const winSelector = (up: { mac?: boolean; whisper?: boolean }) => {
    const s = new SpeechEngineSelector(defaultSpeechSettings("win32"));
    s.register(entry("mac-node", "node", { up: up.mac ?? true }));
    s.register(entry("whisper", "gateway", { up: up.whisper ?? true }));
    s.register(entry("web-speech", "client"));
    return s;
  };

  it("is whisper → the helper → Web Speech on win32 and unchanged on darwin and linux", () => {
    expect(defaultSpeechSettings("win32").stt.order).toEqual(["whisper", "mac-node", "web-speech"]);
    expect(defaultSpeechSettings("darwin").stt.order).toEqual([
      "mac-node",
      "whisper",
      "web-speech",
    ]);
    expect(defaultSpeechSettings("linux").stt.order).toEqual(DEFAULT_SPEECH_SETTINGS.stt.order);
    // A copy: configuring one selector never edits the shared default.
    defaultSpeechSettings("darwin").stt.order.push("x");
    expect(DEFAULT_SPEECH_SETTINGS.stt.order).toHaveLength(3);
  });

  it("uses whisper for dictation and files on Windows once installed, else the helper (SAPI)", async () => {
    for (const purpose of ["dictation", "file"] as const) {
      expect((await winSelector({}).select({ purpose, caller: "desktop" })).id).toBe("whisper");
      expect(
        (await winSelector({ whisper: false }).select({ purpose, caller: "desktop" })).id,
      ).toBe("mac-node");
    }
    const explain = await winSelector({ whisper: false }).explain({ purpose: "dictation" });
    expect(explain.map((e) => [e.id, e.eligible])).toEqual([
      ["whisper", false],
      ["mac-node", true],
      ["web-speech", false],
    ]);
  });

  it("keeps the owner's speech.stt.order on any host", async () => {
    const s = winSelector({});
    s.configure({ stt: { order: parseSttOrder(["mac-node", "whisper"]) ?? [] } });
    expect((await s.select({ purpose: "dictation", caller: "desktop" })).id).toBe("mac-node");
  });

  it("reads speech.stt.order defensively", () => {
    expect(parseSttOrder(["whisper", "mac-node", "whisper"])).toEqual(["whisper", "mac-node"]);
    expect(parseSttOrder(["ok", 3, "bad id!", ""])).toEqual(["ok"]);
    expect(parseSttOrder([])).toBeUndefined();
    expect(parseSttOrder("whisper")).toBeUndefined();
    expect(parseSttOrder(null)).toBeUndefined();
  });
});
