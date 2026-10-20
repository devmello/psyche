// @vitest-environment happy-dom
import { type GatewayCall, GatewayProvider, toBase64 } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComposedFilesPane,
  conversionUnavailableMessage,
  gatewayConversion,
  viewerItemOf,
} from "../../src/compose/viewers.tsx";

afterEach(cleanup);

const gatewayError = (code: string, details?: unknown) =>
  Object.assign(new Error(`${code} from the Gateway`), { code, details });

describe("Office conversion through the Gateway (P4)", () => {
  it("words each reason conversion can't run", () => {
    expect(
      conversionUnavailableMessage(gatewayError("unavailable", { reason: "image_missing" })),
    ).toMatch(/needs the full sandbox image, which includes LibreOffice/);
    expect(
      conversionUnavailableMessage(gatewayError("unavailable", { reason: "sandbox_unavailable" })),
    ).toMatch(/no container runtime/);
    // A Gateway from before documents.convert existed.
    expect(conversionUnavailableMessage(gatewayError("not_implemented"))).toMatch(
      /full sandbox image/,
    );
    expect(conversionUnavailableMessage(gatewayError("invalid_params"))).toBeNull();
  });

  it("converts slides in chunks, and reports an unavailable converter by name", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
    const ok = (async (_m: string, p: { offset?: number }) => {
      const offset = p.offset ?? 0;
      const end = offset === 0 ? 4 : pdf.length;
      return {
        mime: "application/pdf",
        size: pdf.length,
        offset,
        bytes: toBase64(pdf.subarray(offset, end)),
        nextOffset: end < pdf.length ? end : null,
      };
    }) as unknown as GatewayCall;
    const service = gatewayConversion(ok, { path: "/Users/you/deck.pptx" });
    expect(service.supports({ name: "deck.pptx", mime: "" }, "pdf")).toBe(true);
    expect(service.supports({ name: "photo.png", mime: "image/png" }, "pdf")).toBe(false);
    const input = { name: "deck.pptx", mime: "", bytes: new Uint8Array() };
    expect(await service.convert(input, "pdf")).toEqual({ kind: "pdf", bytes: pdf });

    const missing = (async () => {
      throw gatewayError("unavailable", { reason: "image_missing" });
    }) as unknown as GatewayCall;
    const err = await gatewayConversion(missing, { path: "/Users/you/deck.pptx" })
      .convert(input, "pdf")
      .catch((e: unknown) => e as Error);
    expect((err as Error).name).toBe("ConversionUnavailableError");
    expect((err as Error).message).toMatch(/full sandbox image/);
  });

  it("trusts only files the agent made", () => {
    expect(
      viewerItemOf({ path: "/Users/you/a.pdf", name: "a.pdf", size: 10, modifiedAt: null }),
    ).toEqual({
      id: "/Users/you/a.pdf",
      name: "a.pdf",
      mime: "application/pdf",
      size: 10,
      provenance: "untrusted",
    });
  });
});

describe("the composed Files pane", () => {
  it("opens a granted file in the viewers", async () => {
    const gw = new MockGateway({
      settings: { "permissions.policy": { folders: [{ path: "/Users/you/Notes", mode: "ro" }] } },
      files: {
        "/Users/you/Notes": { kind: "folder" },
        "/Users/you/Notes/todo.txt": { kind: "file", text: "buy milk" },
      },
    });
    render(
      <GatewayProvider client={gw}>
        <ComposedFilesPane target="/Users/you/Notes/todo.txt" navigate={() => undefined} />
      </GatewayProvider>,
    );
    const preview = await screen.findByRole("region", { name: "Preview of todo.txt" });
    expect(within(preview).getByRole("heading", { name: "todo.txt" })).toBeTruthy();
    // The viewer host mounts and reads the file through files.read.
    await screen.findByTestId("files-preview");
    await expect
      .poll(() => gw.calls.some((c) => c.method === "files.read"), { timeout: 5000 })
      .toBe(true);
  });
});
