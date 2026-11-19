import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FILE_ROOTS, FIXTURE_NOW, fileRootGrants } from "../src/fixtures/index.ts";
import {
  canEditPath,
  type FileEditSession,
  FilesPane,
  fileEditKind,
} from "../src/screens/files/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const NOW = Date.parse(FIXTURE_NOW);
const README = `${FILE_ROOTS.project}/README.md`;
const LISBON = `${FILE_ROOTS.documents}/Trips/lisbon.md`;

/** A bare editor: one textarea and a Save button, on the pane's session. */
function TestEditor({ session }: { session: FileEditSession }) {
  const [draft, setDraft] = useState(session.text);
  const [base, setBase] = useState(session.text);
  return (
    <div>
      <textarea
        aria-label="Body"
        value={draft}
        readOnly={session.readOnly}
        data-raw={JSON.stringify(session.text)}
        onChange={(e) => {
          setDraft(e.target.value);
          session.setDirty(e.target.value !== base);
        }}
      />
      <button
        type="button"
        onClick={async () => {
          if (await session.save(draft)) {
            setBase(draft);
            session.setDirty(false);
          }
        }}
      >
        Save now
      </button>
      <button type="button" onClick={() => session.save(session.text)}>
        Save unchanged
      </button>
    </div>
  );
}

function setup(target: string, files: Record<string, string> = {}) {
  let gw: MockGateway | null = null;
  const tree = (to: string) => (
    <StoryWorld
      edit={(w) => {
        w.settings["permissions.policy"] = { folders: fileRootGrants() };
        for (const [path, text] of Object.entries(files)) {
          w.files[path] = { kind: "file", text, modifiedAt: "2026-11-19T08:00:00Z" };
        }
      }}
      onGateway={(g) => (gw = g)}
    >
      <FilesPane
        now={NOW}
        target={to}
        renderViewer={(f) => <p>viewer for {f.name}</p>}
        renderEditor={(s) => <TestEditor session={s} />}
      />
    </StoryWorld>
  );
  const view = render(tree(target));
  const get = () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw as MockGateway;
  };
  return Object.assign(get, { retarget: (to: string) => view.rerender(tree(to)) });
}

const edit = async () => userEvent.click(await screen.findByRole("button", { name: "Edit" }));
const type = async (text: string) => {
  const box = await screen.findByRole("textbox", { name: "Body" });
  await userEvent.clear(box);
  await userEvent.type(box, text);
};

describe("which files can be edited", () => {
  const grants = [
    { path: "/a", access: "rw" as const },
    { path: "/a/ro", access: "ro" as const },
  ];
  it.each([
    ["/a/x.md", true],
    ["/a/x.markdown", true],
    ["/a/x.txt", true],
    ["/a/X.CSV", true],
    ["/a/deep/er/x.md", true],
    ["/a/ro/x.md", false],
    ["/a/x.xlsx", false],
    ["/a/x.pdf", false],
    ["/a/x", false],
    ["/b/x.md", false],
    ["/ab/x.md", false],
    ["/a", false],
    [undefined, false],
  ])("%s -> %s", (path, ok) => {
    expect(canEditPath(path, grants)).toBe(ok);
  });
  it("never offers an exact grant path (a single attached file)", () => {
    expect(canEditPath("/f/x.md", [{ path: "/f/x.md", access: "rw" }])).toBe(false);
  });
  it("reads the kind from the name", () => {
    expect(fileEditKind("a.csv")).toBe("csv");
    expect(fileEditKind("a.md")).toBe("markdown");
    expect(fileEditKind("a.xlsx")).toBeNull();
  });
});

describe("the Files pane editor", () => {
  it("offers Edit in a read & write folder only, and says read only elsewhere", async () => {
    setup(README);
    expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByText(/Read only/)).toBeNull();
  });

  it("shows the viewer and a read-only note for a markdown file in a read-only folder", async () => {
    setup(LISBON);
    expect(await screen.findByText("viewer for lisbon.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText(/Read only/)).toBeTruthy();
  });

  it("offers nothing for a file the Gateway does not save", async () => {
    setup(`${FILE_ROOTS.project}/pitch.pptx`);
    expect(await screen.findByText("viewer for pitch.pptx")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByText(/Read only/)).toBeNull();
  });

  it("saves through files.write with the etag files.read gave, and again with the new one", async () => {
    const gw = setup(README);
    await edit();
    await type("# one");
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(gw().fileWrites).toHaveLength(1));
    expect(gw().fileWrites[0]).toMatchObject({ path: README, content: "# one" });
    expect(gw().fileWrites[0]?.ifMatch).toMatch(/^\d+-/);
    await type("# two");
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(gw().fileWrites).toHaveLength(2));
    expect(gw().fileWrites[1]?.ifMatch).not.toBe(gw().fileWrites[0]?.ifMatch);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks before Done throws away unsaved edits, and not when there are none", async () => {
    setup(README);
    await edit();
    await screen.findByRole("textbox", { name: "Body" });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByText("viewer for README.md")).toBeTruthy();

    await edit();
    await type("changed");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Body" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }),
    );
    expect(await screen.findByText("viewer for README.md")).toBeTruthy();
  });

  it("asks before another file replaces unsaved edits", async () => {
    setup(README);
    await edit();
    await type("changed");
    const tree = screen.getByRole("navigation", { name: "Shared folders" });
    const other = await within(tree).findByRole("button", { name: "budget.xlsx" });
    await userEvent.click(other);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("viewer for budget.xlsx")).toBeTruthy();
  });

  it("on a conflict offers Reload, which shows what is on disk", async () => {
    const gw = setup(README);
    await edit();
    await type("mine");
    gw().world.files[README] = {
      kind: "file",
      text: "# changed elsewhere, and longer\n",
      modifiedAt: "2026-11-19T10:00:00Z",
    };
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("changed on disk");
    expect(gw().fileWrites).toHaveLength(0);
    await userEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement).value).toBe(
        "# changed elsewhere, and longer\n",
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(gw().fileWrites).toHaveLength(0);
  });

  it("on a conflict, Overwrite re-reads the etag and asks once more before it writes", async () => {
    const gw = setup(README);
    await edit();
    await type("mine");
    gw().world.files[README] = {
      kind: "file",
      text: "# changed elsewhere, and longer\n",
      modifiedAt: "2026-11-19T10:00:00Z",
    };
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    const alert = await screen.findByRole("alert");
    // The file changes yet again while the owner decides: Overwrite replaces what is there now.
    gw().world.files[README] = {
      kind: "file",
      text: "# changed again, longer still\n",
      modifiedAt: "2026-11-19T10:05:00Z",
    };
    await userEvent.click(within(alert).getByRole("button", { name: "Overwrite…" }));
    expect(await screen.findByText(/newer version is lost/)).toBeTruthy();
    expect(gw().fileWrites).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(gw().fileWrites).toHaveLength(1));
    expect(gw().fileWrites[0]).toMatchObject({
      content: "mine",
      ifMatch: `${new TextEncoder().encode("# changed again, longer still\n").length}-2026-11-19T10:05:00Z`,
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // The editor restarted on what was saved, with nothing unsaved.
    expect((screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement).value).toBe(
      "mine",
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancelling the second question writes nothing", async () => {
    const gw = setup(README);
    await edit();
    await type("mine");
    gw().world.files[README] = {
      kind: "file",
      text: "# changed elsewhere, and longer\n",
      modifiedAt: "2026-11-19T10:00:00Z",
    };
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    await userEvent.click(await screen.findByRole("button", { name: "Overwrite…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Overwrite…" })).toBeTruthy();
    expect(gw().fileWrites).toHaveLength(0);
  });

  it("says why a save failed", async () => {
    const gw = setup(README);
    await edit();
    await type("mine");
    gw().admin = false;
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("couldn't save README.md");
  });
});

describe("edits that must not be lost or changed", () => {
  it("blocks typing while the conflict banner shows, and Overwrite saves exactly what is shown", async () => {
    const gw = setup(README);
    await edit();
    await type("mine");
    gw().world.files[README] = {
      kind: "file",
      text: "# changed elsewhere, and longer\n",
      modifiedAt: "2026-11-19T10:00:00Z",
    };
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    const alert = await screen.findByRole("alert");
    const box = screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    await userEvent.type(box, " plus more");
    expect(box.value).toBe("mine");
    await userEvent.click(within(alert).getByRole("button", { name: "Overwrite…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(gw().fileWrites).toHaveLength(1));
    expect(gw().fileWrites[0]?.content).toBe("mine");
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement).value).toBe(
        "mine",
      ),
    );
    expect((screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement).readOnly).toBe(
      false,
    );
  });

  it("asks before a new target replaces unsaved edits, and keeps them on Keep editing", async () => {
    const other = `${FILE_ROOTS.project}/other.md`;
    const view = setup(README, { [other]: "# other\n" });
    await edit();
    await type("changed");
    view.retarget(other);
    const ask = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement).value).toBe(
      "changed",
    );
    expect(screen.getByRole("region", { name: "Preview of README.md" })).toBeTruthy();
  });

  it("shows the new target once the owner discards the edits", async () => {
    const other = `${FILE_ROOTS.project}/other.md`;
    const view = setup(README, { [other]: "# other\n" });
    await edit();
    await type("changed");
    view.retarget(other);
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }),
    );
    expect(await screen.findByRole("region", { name: "Preview of other.md" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
  });

  it("switches targets at once when nothing is unsaved", async () => {
    const other = `${FILE_ROOTS.project}/other.md`;
    const view = setup(README, { [other]: "# other\n" });
    await edit();
    await screen.findByRole("textbox", { name: "Body" });
    view.retarget(other);
    expect(await screen.findByRole("region", { name: "Preview of other.md" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("restores the byte-order mark and CRLF line endings the file had", async () => {
    const path = `${FILE_ROOTS.project}/crlf.txt`;
    const gw = setup(path, { [path]: "\uFEFFone\r\ntwo\r\n" });
    await edit();
    const box = (await screen.findByRole("textbox", { name: "Body" })) as HTMLTextAreaElement;
    expect(box.value).toBe("one\ntwo\n");
    fireEvent.change(box, { target: { value: "one\ntwo\nthree\n" } });
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(gw().fileWrites).toHaveLength(1));
    expect(gw().fileWrites[0]?.content).toBe("\uFEFFone\r\ntwo\r\nthree\r\n");
  });

  it("writes LF files back as LF and does not invent a mark", async () => {
    const path = `${FILE_ROOTS.project}/lf.md`;
    const gw = setup(path, { [path]: "a\nb\n" });
    await edit();
    await type("a\nb\nc");
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(gw().fileWrites).toHaveLength(1));
    expect(gw().fileWrites[0]?.content).toBe("a\nb\nc");
  });

  it("refuses to edit a file that mixes line endings", async () => {
    const path = `${FILE_ROOTS.project}/mixed.txt`;
    setup(path, { [path]: "a\r\nb\nc\r\n" });
    await edit();
    expect((await screen.findByRole("alert")).textContent).toContain("mixes line-ending styles");
    expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
  });

  it("hands a CSV to its editor untouched, mark and line endings included", async () => {
    const path = `${FILE_ROOTS.project}/data.csv`;
    const raw = "\uFEFFa,b\r\n1,2\r\n";
    const gw = setup(path, { [path]: raw });
    await edit();
    const box = await screen.findByRole("textbox", { name: "Body" });
    expect(box.getAttribute("data-raw")).toBe(JSON.stringify(raw));
    await userEvent.click(screen.getByRole("button", { name: "Save unchanged" }));
    await waitFor(() => expect(gw().fileWrites).toHaveLength(1));
    expect(gw().fileWrites[0]?.content).toBe(raw);
  });
});

describe("size limits", () => {
  it("refuses a save whose JSON request would not fit one frame, without sending it", async () => {
    const gw = setup(README);
    await edit();
    const box = await screen.findByRole("textbox", { name: "Body" });
    // 160k control characters are 160 KB of text but 960 KB once JSON-escaped.
    fireEvent.change(box, { target: { value: "\u0001".repeat(160_000) } });
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("too large to save");
    expect(gw().fileWrites).toHaveLength(0);
    // The editor is still editable and nothing was lost.
    expect(
      (screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement).value,
    ).toHaveLength(160_000);
  });

  it("refuses text over 512 KiB locally", async () => {
    const gw = setup(README);
    await edit();
    fireEvent.change(await screen.findByRole("textbox", { name: "Body" }), {
      target: { value: "a".repeat(512 * 1024 + 1) },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("too large to save");
    expect(gw().fileWrites).toHaveLength(0);
  });

  it("opens a file over 512 KiB as view only, with a note, when its size is known", async () => {
    const path = `${FILE_ROOTS.project}/big.md`;
    setup(README, { [path]: "a".repeat(512 * 1024 + 1) });
    const tree = screen.getByRole("navigation", { name: "Shared folders" });
    await userEvent.click(await within(tree).findByRole("button", { name: /~\/Projects\/psyche/ }));
    await userEvent.click(await within(tree).findByRole("button", { name: "big.md" }));
    expect(await screen.findByText("viewer for big.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText(/over 512 KB/)).toBeTruthy();
  });

  it("says so when a big file is opened by path and Edit is pressed", async () => {
    const path = `${FILE_ROOTS.project}/big2.md`;
    setup(path, { [path]: "a".repeat(512 * 1024 + 1) });
    await edit();
    expect((await screen.findByRole("alert")).textContent).toContain("over 512 KB");
  });
});
