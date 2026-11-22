// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionService } from "../src/core/convert.ts";
import { CodeViewer } from "../src/react/CodeViewer.tsx";
import { DocumentViewer } from "../src/react/DocumentViewer.tsx";
import { ImageViewer } from "../src/react/ImageViewer.tsx";
import { JsonViewer } from "../src/react/JsonViewer.tsx";
import { SlidesViewer } from "../src/react/SlidesViewer.tsx";
import { PlayerViewer, VideoViewer } from "../src/react/VideoViewer.tsx";
import { sampleDocx, samplePptx } from "./fixtures/office.ts";
import { manyPagePdf } from "./fixtures/pdf.ts";

afterEach(cleanup);

const enc = (s: string) => new TextEncoder().encode(s);
const item = (name: string, mime: string) => ({
  id: name,
  name,
  mime,
  provenance: "trusted" as const,
});

describe("CodeViewer", () => {
  it("shows code read-only with line numbers and Shiki colors", async () => {
    render(
      <CodeViewer
        item={item("main.ts", "text/typescript")}
        load={async () => enc("const x = 1;\nexport default x;\n")}
      />,
    );
    const content = await screen.findByLabelText("main.ts source");
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(screen.getByText("typescript")).toBeTruthy();
    await waitFor(() => expect(content.querySelector("[style*='color']")).not.toBeNull());
    expect(document.querySelector(".cm-lineNumbers")).not.toBeNull();
  });

  it("refuses files over the view cap", async () => {
    const huge = { byteLength: 30 * 1024 * 1024 } as Uint8Array;
    render(<CodeViewer item={item("big.log", "text/plain")} load={async () => huge} />);
    expect(await screen.findByText("This file could not be shown")).toBeTruthy();
  });
});

describe("JsonViewer", () => {
  it("renders a collapsible tree, pages long arrays and toggles raw", async () => {
    const data = {
      name: "Ada",
      tags: Array.from({ length: 250 }, (_, i) => i),
      nested: { deep: { deeper: true } },
    };
    render(
      <JsonViewer
        item={item("a.json", "application/json")}
        load={async () => enc(JSON.stringify(data))}
      />,
    );
    const tree = await screen.findByLabelText("a.json tree");
    expect(within(tree).getByText('"Ada"')).toBeTruthy();
    expect(within(tree).getByText("Show 100 more of 150")).toBeTruthy();
    fireEvent.click(within(tree).getByText("Show 100 more of 150"));
    expect(within(tree).getByText("Show 50 more of 50")).toBeTruthy();
    // depth ≥ 2 starts collapsed
    const deep = within(tree).getByText("deep").closest("button");
    expect(deep?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByText("Raw"));
    expect(await screen.findByLabelText("a.json source")).toBeTruthy();
  });

  it("reads JSON Lines and falls back to raw for invalid JSON", async () => {
    render(
      <JsonViewer
        item={item("e.jsonl", "application/json")}
        load={async () => enc('{"a":1}\n{"a":2}\n')}
      />,
    );
    expect(await screen.findByText("[2]")).toBeTruthy();
    cleanup();
    render(
      <JsonViewer item={item("bad.json", "application/json")} load={async () => enc("{nope")} />,
    );
    expect(await screen.findByText(/Not valid JSON/)).toBeTruthy();
  });
});

describe("ImageViewer", () => {
  it("renders an img from bytes and zooms", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:test/1";
    });
    URL.revokeObjectURL = vi.fn();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    render(<ImageViewer item={item("a.png", "image/png")} load={async () => png} />);
    const img = (await screen.findByAltText("a.png")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:test/1");
    expect(created[0]?.type).toBe("image/png");
    fireEvent.click(screen.getByText("100%"));
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(screen.getByLabelText("Zoom level").textContent).toBe("125%");
  });

  it("refuses non-images even with an image name", async () => {
    render(<ImageViewer item={item("x.png", "text/html")} load={async () => enc("<script>")} />);
    expect(await screen.findByText("This file is not a supported image")).toBeTruthy();
  });
});

describe("VideoViewer", () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

  it("plays mp4, mov, webm and m4v with the native element: controls, no autoplay", async () => {
    const made: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      made.push(b);
      return "blob:video/1";
    });
    URL.revokeObjectURL = vi.fn();
    const cases: [string, string, Uint8Array, string][] = [
      ["a.mp4", "video/mp4", mp4, "video/mp4"],
      [
        "a.mov",
        "video/quicktime",
        new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]),
        "video/quicktime",
      ],
      ["a.webm", "video/webm", webm, "video/webm"],
      [
        "a.m4v",
        "video/x-m4v",
        new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x56, 0x20]),
        "video/x-m4v",
      ],
    ];
    for (const [name, mime, bytes, type] of cases) {
      const { unmount } = render(<VideoViewer item={item(name, mime)} load={async () => bytes} />);
      const video = (await screen.findByLabelText(name)) as HTMLVideoElement;
      expect(video.tagName).toBe("VIDEO");
      expect(video.controls).toBe(true);
      expect(video.autoplay).toBe(false);
      expect(video.getAttribute("src")).toBe("blob:video/1");
      expect(made.at(-1)?.type).toBe(type);
      unmount();
    }
  });

  it("refuses a non-video type even with a video name", async () => {
    render(<VideoViewer item={item("x.mp4", "text/html")} load={async () => enc("<script>")} />);
    expect(await screen.findByText("This file is not a supported video")).toBeTruthy();
  });

  it("sends audio to the plain player and video to the video viewer", async () => {
    URL.createObjectURL = vi.fn(() => "blob:m/1");
    URL.revokeObjectURL = vi.fn();
    const { container } = render(
      <PlayerViewer item={item("a.mp4", "video/mp4")} load={async () => mp4} />,
    );
    await screen.findByLabelText("a.mp4");
    expect(container.querySelector(".psy-video video")).toBeTruthy();
    cleanup();
    const audio = render(
      <PlayerViewer item={item("a.mp3", "audio/mpeg")} load={async () => enc("ID3")} />,
    );
    await screen.findByLabelText("a.mp3");
    expect(audio.container.querySelector("audio")).toBeTruthy();
    expect(audio.container.querySelector("video")).toBeNull();
  });
});

describe("DocumentViewer", () => {
  it("renders DOCX layout into the sandboxed frame and switches to text", async () => {
    render(
      <DocumentViewer
        item={item(
          "r.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )}
        load={() => sampleDocx()}
      />,
    );
    const frame = (await screen.findByTitle("r.docx")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Quarterly report");
    expect(srcdoc).toMatch(/script-src 'nonce-/);
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    await waitFor(() =>
      expect((screen.getByTitle("r.docx") as HTMLIFrameElement).getAttribute("srcdoc")).toContain(
        "<table>",
      ),
    );
  });
});

describe("SlidesViewer", () => {
  it("shows a placeholder with slide text when no converter is configured", async () => {
    render(
      <SlidesViewer
        item={item(
          "d.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )}
        load={samplePptx}
      />,
    );
    expect(await screen.findByText("Slide preview unavailable")).toBeTruthy();
    const slides = screen.getByLabelText("Slides");
    expect(within(slides).getAllByRole("listitem")).toHaveLength(3);
    expect(within(slides).getByText(/Revenue & growth/)).toBeTruthy();
  });

  it("renders the converted PDF when a converter succeeds", async () => {
    const conversion: ConversionService = {
      id: "fake",
      supports: (_i, t) => t === "pdf",
      convert: async () => ({ kind: "pdf", bytes: manyPagePdf(3) }),
    };
    render(
      <SlidesViewer
        item={item(
          "d.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )}
        load={samplePptx}
        conversion={conversion}
      />,
    );
    expect(await screen.findByText(/of 3/)).toBeTruthy();
  });

  it("falls back to the placeholder when conversion fails", async () => {
    const conversion: ConversionService = {
      id: "fake",
      supports: () => true,
      convert: async () => {
        throw new Error("soffice missing");
      },
    };
    render(
      <SlidesViewer
        item={item(
          "d.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )}
        load={samplePptx}
        conversion={conversion}
      />,
    );
    expect(await screen.findByText(/Conversion failed: soffice missing/)).toBeTruthy();
  });
});
