// @vitest-environment happy-dom
import { GatewayProvider, resetFileDrafts } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import type { SheetEditorProps } from "@psyche/viewers";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposedFilesPane } from "../../src/compose/viewers.tsx";

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

const _gatewayError = (code: string, details?: unknown) =>
  Object.assign(new Error(`${code} from the Gateway`), { code, details });

const NOTES = "/Users/you/Notes";
const stamp = "2026-11-19T08:00:00Z";
const CSV = `${NOTES}/fruit.csv`;
function setupCsv() {
  resetFileDrafts();
  const gw = new MockGateway({
    settings: { "permissions.policy": { folders: [{ path: NOTES, mode: "rw" }] } },
    files: {
      [NOTES]: { kind: "folder" },
      [CSV]: { kind: "file", text: "name,qty\napple,3\n", modifiedAt: stamp },
    },
  });
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
        target={CSV}
        navigate={() => undefined}
        sheetEditor={async () => runtime}
      />
    </GatewayProvider>,
  );
  const editCell = async () => {
    await waitFor(() => expect(state.emit).toBeDefined());
    const sheets = (
      state.data as {
        sheets: Record<string, { cellData: Record<number, Record<number, unknown>> }>;
      }
    ).sheets;
    (sheets["sheet-1"]?.cellData[1] as Record<number, unknown>)[1] = { v: 9, t: 2 };
    act(() => state.emit?.());
  };
  return { gw, state, editCell };
}
// Review round 3 of #1381: the sheet editor reports its draft as it unmounts, which used to land
// after Discard or Reload had dropped it, so the dropped edits came back.
describe("a dropped spreadsheet draft stays dropped", () => {
  it("Done, then Discard, then Edit opens the file without the discarded edits", async () => {
    const { editCell } = setupCsv();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await editCell();
    fireEvent.click((await screen.findAllByRole("button", { name: "Done" }))[0] as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText("Unsaved changes restored")).toBeNull();
    const save = screen.queryByRole("button", { name: "Save" }) as HTMLButtonElement | null;
    expect(save === null || save.disabled).toBe(true);
  });
  it("the sheet's own Done, then Discard, also drops the edits", async () => {
    const { editCell } = setupCsv();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await editCell();
    const dones = await screen.findAllByRole("button", { name: "Done" });
    fireEvent.click(dones[dones.length - 1] as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText("Unsaved changes restored")).toBeNull();
    const save = screen.queryByRole("button", { name: "Save" }) as HTMLButtonElement | null;
    expect(save === null || save.disabled).toBe(true);
  });
  it("Reload leaves a spreadsheet conflict for the file as it is now", async () => {
    const { gw, editCell, state } = setupCsv();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await editCell();
    gw.world.files[CSV] = {
      kind: "file",
      text: "name,qty\npear,1\n",
      modifiedAt: "2026-11-19T09:00:00Z",
    };
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: "Reload" }).length).toBeGreaterThan(0),
    );
    const reloadBtn = screen.getAllByRole("button", { name: "Reload" })[0] as HTMLElement;
    state.emit = undefined;
    fireEvent.click(reloadBtn);
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});
