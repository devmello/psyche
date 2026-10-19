// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IWorkbookData } from "@univerjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNIVER_CELL } from "../src/core/sheet-edit.ts";
import { lossNote, SheetEditor } from "../src/react/SheetEditor.tsx";
import { SheetViewer } from "../src/react/SheetViewer.tsx";
import type { SheetEditorRuntime } from "../src/react/univer.ts";

afterEach(cleanup);

/** Stands in for Univer: keeps the snapshot and lets the test play the user's edits. */
function fakeRuntime() {
  const state: {
    data?: IWorkbookData;
    container?: HTMLElement;
    emit?: () => void;
    disposed: number;
  } = { disposed: 0 };
  const runtime: SheetEditorRuntime = {
    mount(container, data) {
      state.container = container;
      state.data = structuredClone(data);
      const listeners = new Set<() => void>();
      state.emit = () => {
        for (const l of listeners) l();
      };
      return {
        snapshot: () => structuredClone(state.data as IWorkbookData),
        onChange(l) {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        dispose() {
          state.disposed++;
        },
      };
    },
  };
  return { runtime, state };
}

const csv = "name,qty\napple,3\n";
const item = {
  id: "f1",
  name: "fruit.csv",
  mime: "text/csv",
  size: csv.length,
  provenance: "trusted" as const,
};
const load = async () => new TextEncoder().encode(csv);

describe("SheetEditor", () => {
  it("mounts Univer on the snapshot, saves edits back as CSV, and disposes", async () => {
    const { runtime, state } = fakeRuntime();
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    const view = render(
      <SheetEditor
        item={item}
        load={load}
        onSave={onSave}
        onClose={onClose}
        sheetEditor={async () => runtime}
      />,
    );
    await screen.findByText("No changes");
    expect(state.container).toBe(screen.getByTestId("sheet-editor-surface"));
    const cells = state.data?.sheets["sheet-1"]?.cellData as Record<
      number,
      Record<number, unknown>
    >;
    expect(cells[1]?.[1]).toEqual({ v: 3, t: UNIVER_CELL.NUMBER });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    // The user types 5 into B2.
    (cells[1] as Record<number, unknown>)[1] = { v: 5, t: UNIVER_CELL.NUMBER };
    state.emit?.();
    await screen.findByText("Unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = (
      onSave.mock.calls[0] as unknown as [{ name: string; mime: string; bytes: Uint8Array }]
    )[0];
    expect(saved.name).toBe("fruit.csv");
    expect(saved.mime).toBe("text/csv");
    expect(new TextDecoder().decode(saved.bytes)).toBe("name,qty\napple,5\n");
    expect(screen.getByRole("note").textContent).toMatch(/first sheet's values as CSV/);

    view.unmount();
    expect(state.disposed).toBe(1);
  });

  it("asks before discarding unsaved edits", async () => {
    const { runtime, state } = fakeRuntime();
    const onClose = vi.fn();
    render(
      <SheetEditor
        item={item}
        load={load}
        onSave={() => {}}
        onClose={onClose}
        sheetEditor={async () => runtime}
      />,
    );
    await screen.findByText("No changes");
    state.emit?.();
    await screen.findByText("Unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the save error and keeps the edits", async () => {
    const { runtime, state } = fakeRuntime();
    render(
      <SheetEditor
        item={item}
        load={load}
        onSave={async () => {
          throw new Error("etag conflict");
        }}
        onClose={() => {}}
        sheetEditor={async () => runtime}
      />,
    );
    await screen.findByText("No changes");
    state.emit?.();
    await screen.findByText("Unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/etag conflict/);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("falls back to the viewer when the runtime fails to load", async () => {
    const onClose = vi.fn();
    render(
      <SheetEditor
        item={item}
        load={load}
        onSave={() => {}}
        onClose={onClose}
        sheetEditor={async () => {
          throw new Error("chunk failed");
        }}
      />,
    );
    await screen.findByText(/cannot be edited here/);
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("names what a save drops", () => {
    expect(lossNote({ styled: false, comments: false, images: false })).toBeUndefined();
    expect(lossNote({ styled: true, comments: true, images: false })).toMatch(
      /not cell formatting \(fonts, fills, borders\), comments\./,
    );
  });
});

describe("SheetViewer edit mode", () => {
  it("offers Edit only with onSave and an editable format, and re-reads the file after editing", async () => {
    const { runtime } = fakeRuntime();
    let reads = 0;
    const counting = async () => {
      reads++;
      return new TextEncoder().encode(csv);
    };
    const { rerender } = render(<SheetViewer item={item} load={counting} />);
    await screen.findByText(/\d rows?$/);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

    rerender(
      <SheetViewer
        item={item}
        load={counting}
        onSave={() => {}}
        sheetEditor={async () => runtime}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByText("No changes");
    const before = reads;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText(/\d rows?$/);
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it("does not offer Edit for formats it cannot write back", async () => {
    const macro = { ...item, name: "book.xlsm" };
    render(<SheetViewer item={macro} load={load} onSave={() => {}} />);
    await screen.findByText(/\d rows?$/);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
