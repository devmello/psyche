import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointUrl, OpenAiAudioTranscriber } from "../src/index.ts";

/** A whisper-compatible endpoint, faked: no network, no real recordings (#842 item 5). */

let dir: string;
let audio: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "psyche-openai-audio-"));
  audio = join(dir, "meeting.m4a");
  await writeFile(audio, Buffer.from("not really audio"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: FormData;
}

function fakeFetch(respond: () => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      form: init?.body as FormData,
    });
    return respond();
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("OpenAI-compatible transcription endpoint", () => {
  it("posts the recording as verbose_json and maps segments to a long-form transcript", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({
        text: " Ship the fix on Friday. ",
        language: "en",
        duration: 62.5,
        segments: [
          { start: 0, end: 2.25, text: " Ship the fix" },
          { start: 2.25, end: 4, text: " on Friday." },
        ],
      }),
    );
    const t = new OpenAiAudioTranscriber({
      baseUrl: "http://127.0.0.1:8080",
      model: "whisper-1",
      fetch,
    });
    const out = await t.transcribePath(audio, {
      language: "en",
      vocabulary: ["Dana", "Lee"],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:8080/v1/audio/transcriptions");
    expect(seen[0]?.method).toBe("POST");
    const form = seen[0]?.form;
    expect(form?.get("model")).toBe("whisper-1");
    expect(form?.get("response_format")).toBe("verbose_json");
    expect(form?.get("language")).toBe("en");
    expect(form?.get("prompt")).toBe("Dana, Lee");
    expect(form?.get("file")).toBeInstanceOf(Blob);

    expect(out.text).toBe("Ship the fix on Friday.");
    expect(out.audioMs).toBe(62_500);
    expect(out.engine).toBe("openai-audio:whisper-1");
    expect(out.segments).toEqual([
      { text: "Ship the fix", startMs: 0, endMs: 2250, final: true },
      { text: "on Friday.", startMs: 2250, endMs: 4000, final: true },
    ]);
  });

  it("sends a bearer token only when one is configured", async () => {
    const { fetch, seen } = fakeFetch(() => json({ text: "ok", duration: 1, segments: [] }));
    await new OpenAiAudioTranscriber({
      baseUrl: "https://stt.example",
      model: "whisper-1",
      apiKey: "sk-test",
      fetch,
    }).transcribePath(audio);
    expect(seen[0]?.headers.authorization).toBe("Bearer sk-test");

    await new OpenAiAudioTranscriber({
      baseUrl: "http://localhost:8080",
      model: "whisper-1",
      fetch,
    }).transcribePath(audio);
    expect(seen[1]?.headers.authorization).toBeUndefined();
  });

  it("refuses a recording longer than the caller's limit", async () => {
    const { fetch } = fakeFetch(() => json({ text: "long", duration: 7_200, segments: [] }));
    const t = new OpenAiAudioTranscriber({ baseUrl: "http://127.0.0.1:8080", model: "m", fetch });
    await expect(t.transcribePath(audio, { maxDurationMs: 3_600_000 })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("maps a server failure to a retryable unavailable error, and a client error to a final one", async () => {
    const t500 = new OpenAiAudioTranscriber({
      baseUrl: "http://127.0.0.1:8080",
      model: "m",
      fetch: fakeFetch(() => new Response("boom", { status: 503 })).fetch,
    });
    const e500 = await t500.transcribePath(audio).catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(PsycheError);
    expect(e500).toMatchObject({ code: "unavailable", retryable: true });

    const t400 = new OpenAiAudioTranscriber({
      baseUrl: "http://127.0.0.1:8080",
      model: "m",
      fetch: fakeFetch(() => new Response("bad", { status: 400 })).fetch,
    });
    const e400 = await t400.transcribePath(audio).catch((e: unknown) => e);
    expect(e400).toMatchObject({ code: "unavailable", retryable: false });
  });

  it("answers no text with a retryable error rather than an empty transcript", async () => {
    const t = new OpenAiAudioTranscriber({
      baseUrl: "http://127.0.0.1:8080",
      model: "m",
      fetch: fakeFetch(() => json({ duration: 3 })).fetch,
    });
    await expect(t.transcribePath(audio)).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });
});

describe("endpoint address", () => {
  it("accepts https and loopback http, and refuses a plain-text address on the network", () => {
    expect(endpointUrl("https://stt.example").href).toBe(
      "https://stt.example/v1/audio/transcriptions",
    );
    expect(endpointUrl("http://127.0.0.1:8080").hostname).toBe("127.0.0.1");
    expect(endpointUrl("http://localhost:9000").hostname).toBe("localhost");
    expect(() => endpointUrl("http://192.168.1.20:8080")).toThrow(PsycheError);
    expect(() => endpointUrl("ftp://127.0.0.1")).toThrow(PsycheError);
    expect(() => endpointUrl("not a url")).toThrow(PsycheError);
  });
});
