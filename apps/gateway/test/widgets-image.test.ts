import type { PinnedRequest, TransportResponse } from "@psyche/connectors";
import { insertWidget, openDb, setSetting } from "@psyche/db";
import { describe, expect, it } from "vitest";
import type { ComposeServices } from "../src/compose/services.ts";
import { composeWidgets, specImageUrls } from "../src/compose/widgets.ts";
import type { Call } from "../src/context.ts";
import { fetchWidgetImage, WIDGET_IMAGE_MAX_BYTES } from "../src/widgets/image.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const pub = async () => [{ address: "93.184.216.34", family: 4 }];

const reply = (
  status: number,
  headers: Record<string, string>,
  body: Uint8Array[] = [],
): TransportResponse => ({
  status,
  headers,
  body: (async function* () {
    for (const b of body) yield b;
  })(),
  close: () => {},
});

const transportOf = (fn: (req: PinnedRequest) => TransportResponse) => async (req: PinnedRequest) =>
  fn(req);

describe("widget image proxy", () => {
  it("returns a PNG after vetting the host, with no cookies or referrer sent", async () => {
    let seen: PinnedRequest | undefined;
    const img = await fetchWidgetImage("https://img.example/a.png", {
      lookup: pub,
      transport: transportOf((req) => {
        seen = req;
        return reply(200, { "content-type": "image/png" }, [PNG]);
      }),
    });
    expect(img.mime).toBe("image/png");
    expect(img.bytes.length).toBe(PNG.length);
    expect(seen?.address).toBe("93.184.216.34");
    expect(Object.keys(seen?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("cookie");
    expect(Object.keys(seen?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("referer");
  });

  it("refuses http, SVG, a mislabelled body and an oversize image", async () => {
    const t = (r: () => TransportResponse) => ({ lookup: pub, transport: transportOf(r) });
    await expect(
      fetchWidgetImage(
        "http://img.example/a.png",
        t(() => reply(200, {})),
      ),
    ).rejects.toThrow(/https only/);
    await expect(
      fetchWidgetImage(
        "https://img.example/a.svg",
        t(() =>
          reply(200, { "content-type": "image/svg+xml" }, [
            new TextEncoder().encode("<svg onload=x>"),
          ]),
        ),
      ),
    ).rejects.toThrow(/only PNG, JPEG, GIF and WebP/);
    await expect(
      fetchWidgetImage(
        "https://img.example/a.png",
        t(() =>
          reply(200, { "content-type": "image/png" }, [
            new TextEncoder().encode("<html>nope</html>"),
          ]),
        ),
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      fetchWidgetImage(
        "https://img.example/a.png",
        t(() =>
          reply(200, { "content-type": "image/png" }, [new Uint8Array(WIDGET_IMAGE_MAX_BYTES + 1)]),
        ),
      ),
    ).rejects.toThrow(/512 KiB/);
  });

  it("refuses private addresses, literal or resolved, and a redirect into the LAN", async () => {
    const never = transportOf(() => reply(200, { "content-type": "image/png" }, [PNG]));
    await expect(
      fetchWidgetImage("https://127.0.0.1/a.png", { transport: never }),
    ).rejects.toThrow();
    await expect(
      fetchWidgetImage("https://sneaky.example/a.png", {
        lookup: async () => [{ address: "10.0.0.5", family: 4 }],
        transport: never,
      }),
    ).rejects.toThrow();
    await expect(
      fetchWidgetImage("https://img.example/a.png", {
        lookup: async (h) =>
          h === "img.example"
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "192.168.1.9", family: 4 }],
        transport: transportOf((req) =>
          req.url.hostname === "img.example"
            ? reply(302, { location: "https://lan.example/x.png" })
            : reply(200, { "content-type": "image/png" }, [PNG]),
        ),
      }),
    ).rejects.toThrow();
  });
});

describe("widgets.image handler", () => {
  const setup = () => {
    const db = openDb(":memory:");
    const w = insertWidget(db, {
      threadId: "thr_1",
      messageId: "m",
      spec: {
        v: 1,
        title: "Pic",
        fallbackText: "A picture",
        root: {
          id: "root",
          type: "image",
          alt: "A cat",
          src: { url: "https://img.example/cat.png" },
        },
      },
      taint: [],
      owner: { kind: "run", runId: "r" },
    });
    const part = composeWidgets({
      db,
      tools: { register: () => () => {} },
      publish: () => {},
    } as unknown as ComposeServices);
    const run = part.handlers?.["widgets.image"]?.run as (c: Call, p: unknown) => Promise<unknown>;
    return { db, w, run };
  };

  it("is off by default (D3)", async () => {
    const { w, run } = setup();
    await expect(
      run({} as Call, { widgetId: w.id, url: "https://img.example/cat.png" }),
    ).rejects.toThrow(/off/);
  });

  it("only fetches a URL the widget's own spec names, so it is no open proxy", async () => {
    const { db, w, run } = setup();
    setSetting(db, "widgets.remoteImages", true);
    await expect(
      run({} as Call, { widgetId: w.id, url: "https://other.example/x.png" }),
    ).rejects.toThrow(/not part of this widget/);
    await expect(
      run({} as Call, { widgetId: "nope", url: "https://img.example/cat.png" }),
    ).rejects.toThrow(/not part of this widget/);
  });

  it("finds image urls in nested specs", () => {
    expect(
      specImageUrls({
        id: "r",
        type: "stack",
        children: [
          { id: "i", type: "image", alt: "a", src: { url: "https://a.example/1.png" } },
          { id: "j", type: "image", alt: "b", src: { fileId: "f" } },
        ],
      }),
    ).toEqual(["https://a.example/1.png"]);
  });
});
