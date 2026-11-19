import { render, screen, waitFor, within } from "@testing-library/react";
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
    </div>
  );
}

function setup(target: string) {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      edit={(w) => {
        w.settings["permissions.policy"] = { folders: fileRootGrants() };
      }}
      onGateway={(g) => (gw = g)}
    >
      <FilesPane
        now={NOW}
        target={target}
        renderViewer={(f) => <p>viewer for {f.name}</p>}
        renderEditor={(s) => <TestEditor session={s} />}
      />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw as MockGateway;
  };
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
    expect(gw().fileWrites[0]?.create).toBeUndefined();
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
