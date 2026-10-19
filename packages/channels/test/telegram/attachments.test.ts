import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { FAKE_TOKEN, harness, response } from "./helpers.ts";

const VOICE_REF = "AwACAgEAAxkBAAIB_GZ2b2ljZS1ub3RlLWZpbGUtaWQAAk4F";

function recordingFetch(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return answer(url);
  }) as typeof fetch;
  return { fn, urls };
}

async function caught(p: Promise<unknown>): Promise<PsycheError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PsycheError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

function leaksToken(err: PsycheError): boolean {
  const seen = JSON.stringify({ m: err.message, d: err.details, s: err.stack });
  return seen.includes(FAKE_TOKEN) || seen.includes("TEST-TOKEN") || err.cause !== undefined;
}

describe("TelegramAdapter fetchAttachment", () => {
  it("resolves the ref with getFile and downloads through the injected fetch", async () => {
    const bytes = new Uint8Array([79, 103, 103, 83, 0, 2]);
    const f = recordingFetch(() => new Response(bytes, { status: 200 }));
    const { adapter, api } = await harness({ fetch: f.fn });
    const data = await adapter.fetchAttachment(VOICE_REF);
    expect(Array.from(data)).toEqual(Array.from(bytes));
    expect(api.calls).toEqual([{ method: "getFile", payload: { file_id: VOICE_REF } }]);
    expect(f.urls).toEqual([`https://api.telegram.org/file/bot${FAKE_TOKEN}/voice/file_12.oga`]);
  });

  it("honours a custom apiRoot for downloads", async () => {
    const f = recordingFetch(() => new Response(new Uint8Array([1])));
    const { adapter } = await harness({ fetch: f.fn, apiRoot: "http://127.0.0.1:8081/" });
    await adapter.fetchAttachment(VOICE_REF);
    expect(f.urls[0]).toBe(`http://127.0.0.1:8081/file/bot${FAKE_TOKEN}/voice/file_12.oga`);
  });

  it("reports HTTP failures as unavailable without the URL or token", async () => {
    const f = recordingFetch(() => new Response("nope", { status: 502 }));
    const { adapter } = await harness({ fetch: f.fn });
    const err = await caught(adapter.fetchAttachment(VOICE_REF));
    expect(err.code).toBe("unavailable");
    expect(err.message).not.toContain("api.telegram.org");
    expect(leaksToken(err)).toBe(false);
  });

  it("reports network failures without leaking the token", async () => {
    const f = recordingFetch((url) => {
      throw new TypeError(`fetch failed for ${url}`);
    });
    const { adapter } = await harness({ fetch: f.fn });
    const err = await caught(adapter.fetchAttachment(VOICE_REF));
    expect(err.code).toBe("unavailable");
    expect(err.retryable).toBe(true);
    expect(leaksToken(err)).toBe(false);
  });

  it("refuses files whose declared size exceeds the cap without downloading", async () => {
    const f = recordingFetch(() => new Response(new Uint8Array(10)));
    const { adapter } = await harness({ fetch: f.fn, maxDownloadBytes: 1000 });
    const err = await caught(adapter.fetchAttachment(VOICE_REF));
    expect(err.code).toBe("invalid_params");
    expect(err.message).toBe("attachment too large");
    expect(f.urls).toEqual([]);
  });

  it("enforces the cap on the bytes actually received", async () => {
    const f = recordingFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(600));
              controller.enqueue(new Uint8Array(600));
              controller.close();
            },
          }),
        ),
    );
    const { adapter, api } = await harness({ fetch: f.fn, maxDownloadBytes: 1000 });
    const getFile = response("getFile");
    delete (getFile.result as { file_size?: number }).file_size;
    api.override("getFile", getFile);
    const err = await caught(adapter.fetchAttachment(VOICE_REF));
    expect(err.code).toBe("invalid_params");
    expect(err.message).toBe("attachment too large");
  });

  it("maps getFile errors and scrubs them", async () => {
    const { adapter, api } = await harness();
    api.override("getFile", response("error400"));
    const err = await caught(adapter.fetchAttachment("bogus"));
    expect(err.code).toBe("invalid_params");
    expect(leaksToken(err)).toBe(false);
  });
});
