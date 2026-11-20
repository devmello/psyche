// @vitest-environment happy-dom
import { type GatewayCall, GatewayProvider, resetFileDrafts, toBase64 } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import type { SheetEditorProps } from "@psyche/viewers";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposedFilesPane,
  conversionUnavailableMessage,
  gatewayConversion,
  viewerItemOf,
} from "../../src/compose/viewers.tsx";

// CodeMirror needs a real layout engine: stand a textarea in for the Markdown editor.
vi.mock("@psyche/viewers", async (orig) => ({
  ...(await orig<typeof import("@psyche/viewers")>()),
  ControlledMarkdownEditor: (p: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Markdown" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));

afterEach(() => {
  cleanup();
  resetFileDrafts();
});

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

describe("editing in the composed Files pane", () => {
  const NOTES = "/Users/you/Notes";
  const stamp = "2026-11-19T08:00:00Z";
  const world = () =>
    new MockGateway({
      settings: { "permissions.policy": { folders: [{ path: NOTES, mode: "rw" }] } },
      files: {
        [NOTES]: { kind: "folder" },
        [`${NOTES}/todo.md`]: { kind: "file", text: "buy milk\n", modifiedAt: stamp },
        [`${NOTES}/fruit.csv`]: { kind: "file", text: "name,qty\napple,3\n", modifiedAt: stamp },
      },
    });

  it("saves a Markdown file through files.write with the etag of the read", async () => {
    const gw = world();
    render(
      <GatewayProvider client={gw}>
        <ComposedFilesPane target={`${NOTES}/todo.md`} navigate={() => undefined} />
      </GatewayProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const box = await screen.findByRole("textbox", { name: "Markdown" });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "buy milk\nand eggs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gw.fileWrites).toHaveLength(1));
    expect(gw.fileWrites[0]).toEqual({
      path: `${NOTES}/todo.md`,
      content: "buy milk\nand eggs",
      ifMatch: `${"buy milk\n".length}-${stamp}`,
    });
    await screen.findByText("Saved");
  });

  it("round-trips a CSV file through the spreadsheet editor", async () => {
    const gw = world();
    type Runtime = Awaited<ReturnType<NonNullable<SheetEditorProps["sheetEditor"]>>>;
    const state: { data?: unknown; emit?: () => void } = {};
    const runtime = {
      mount(_el: HTMLElement, data: unknown) {
        state.data = structuredClone(data);
        const listeners = new Set<() => void>();
        state.emit = () => {
          for (const l of listeners) l();
        };
        return {
          snapshot: () => structuredClone(state.data),
          onChange(l: () => void) {
            listeners.add(l);
            return () => listeners.delete(l);
          },
          dispose() {},
        };
      },
    } as unknown as Runtime;
    render(
      <GatewayProvider client={gw}>
        <ComposedFilesPane
          target={`${NOTES}/fruit.csv`}
          navigate={() => undefined}
          sheetEditor={async () => runtime}
        />
      </GatewayProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(state.emit).toBeDefined());
    const sheets = (
      state.data as {
        sheets: Record<string, { cellData: Record<number, Record<number, unknown>> }>;
      }
    ).sheets;
    // The user types 5 into B2.
    (sheets["sheet-1"]?.cellData[1] as Record<number, unknown>)[1] = { v: 5, t: 2 };
    act(() => state.emit?.());
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(gw.fileWrites).toHaveLength(1));
    expect(gw.fileWrites[0]).toMatchObject({
      path: `${NOTES}/fruit.csv`,
      content: "name,qty\napple,5\n",
      ifMatch: `${"name,qty\napple,3\n".length}-${stamp}`,
    });
    await screen.findByText("Saved");
    // What the Gateway holds now reads back as the edited CSV.
    expect((gw.world.files[`${NOTES}/fruit.csv`] as { text: string }).text).toBe(
      "name,qty\napple,5\n",
    );
  });

  it("keeps a CSV's byte-order mark and CRLF line endings through a save", async () => {
    const raw = "\uFEFFname,qty\r\napple,3\r\n";
    const gw = world();
    gw.world.files[`${NOTES}/win.csv`] = { kind: "file", text: raw, modifiedAt: stamp };
    type Runtime = Awaited<ReturnType<NonNullable<SheetEditorProps["sheetEditor"]>>>;
    const state: { data?: unknown; emit?: () => void } = {};
    const runtime = {
      mount(_el: HTMLElement, data: unknown) {
        state.data = structuredClone(data);
        const listeners = new Set<() => void>();
        state.emit = () => {
          for (const l of listeners) l();
        };
        return {
          snapshot: () => structuredClone(state.data),
          onChange(l: () => void) {
            listeners.add(l);
            return () => listeners.delete(l);
          },
          dispose() {},
        };
      },
    } as unknown as Runtime;
    render(
      <GatewayProvider client={gw}>
        <ComposedFilesPane
          target={`${NOTES}/win.csv`}
          navigate={() => undefined}
          sheetEditor={async () => runtime}
        />
      </GatewayProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(state.emit).toBeDefined());
    const sheets = (
      state.data as {
        sheets: Record<string, { cellData: Record<number, Record<number, unknown>> }>;
      }
    ).sheets;
    (sheets["sheet-1"]?.cellData[1] as Record<number, unknown>)[1] = { v: 5, t: 2 };
    act(() => state.emit?.());
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(gw.fileWrites).toHaveLength(1));
    expect(gw.fileWrites[0]?.content).toBe("\uFEFFname,qty\r\napple,5\r\n");
  });

  it("keeps an unsaved CSV edit when the pane is swapped out, and restores it", async () => {
    const gw = world();
    type Runtime = Awaited<ReturnType<NonNullable<SheetEditorProps["sheetEditor"]>>>;
    const fake = () => {
      const state: { data?: unknown; emit?: () => void } = {};
      const runtime = {
        mount(_el: HTMLElement, data: unknown) {
          state.data = structuredClone(data);
          const listeners = new Set<() => void>();
          state.emit = () => {
            for (const l of listeners) l();
          };
          return {
            snapshot: () => structuredClone(state.data),
            onChange(l: () => void) {
              listeners.add(l);
              return () => listeners.delete(l);
            },
            dispose() {},
          };
        },
      } as unknown as Runtime;
      return { state, runtime };
    };
    const cells = (data: unknown) =>
      (data as { sheets: Record<string, { cellData: Record<number, Record<number, unknown>> }> })
        .sheets["sheet-1"]?.cellData as Record<number, Record<number, unknown>>;
    const pane = (runtime: Runtime) => (
      <GatewayProvider client={gw}>
        <ComposedFilesPane
          target={`${NOTES}/fruit.csv`}
          navigate={() => undefined}
          sheetEditor={async () => runtime}
        />
      </GatewayProvider>
    );
    const first = fake();
    const view = render(pane(first.runtime));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(first.state.emit).toBeDefined());
    (cells(first.state.data)[1] as Record<number, unknown>)[1] = { v: 7, t: 2 };
    act(() => first.state.emit?.());
    await screen.findByText("Unsaved changes");
    // Another tab takes over: the pane unmounts with the edit unsaved.
    view.unmount();
    const second = fake();
    render(pane(second.runtime));
    await screen.findByText("Unsaved changes restored");
    await waitFor(() => expect(second.state.data).toBeDefined());
    expect(cells(second.state.data)[1]?.[1]).toMatchObject({ v: 7 });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gw.fileWrites).toHaveLength(1));
    expect(gw.fileWrites[0]?.content).toBe("name,qty\napple,7\n");
  });

  it("keeps an unsaved Markdown edit across a swap-out", async () => {
    const gw = world();
    const pane = (
      <GatewayProvider client={gw}>
        <ComposedFilesPane target={`${NOTES}/todo.md`} navigate={() => undefined} />
      </GatewayProvider>
    );
    const view = render(pane);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Markdown" }), {
      target: { value: "buy milk\nand bread" },
    });
    view.unmount();
    render(pane);
    expect(
      ((await screen.findByRole("textbox", { name: "Markdown" })) as HTMLTextAreaElement).value,
    ).toBe("buy milk\nand bread");
    await screen.findByText("Unsaved changes restored");
  });

  it("offers no editor in a read-only folder", async () => {
    const gw = world();
    gw.world.settings["permissions.policy"] = { folders: [{ path: NOTES, mode: "ro" }] };
    render(
      <GatewayProvider client={gw}>
        <ComposedFilesPane target={`${NOTES}/todo.md`} navigate={() => undefined} />
      </GatewayProvider>,
    );
    await screen.findByRole("region", { name: "Preview of todo.md" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText(/Read only/)).toBeTruthy();
  });
});
