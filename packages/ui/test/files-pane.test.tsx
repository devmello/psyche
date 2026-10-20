import { FILE_CHUNK_BYTES, type MethodResult } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type GatewayCall, readFileBytes, toBase64 } from "../src/data/files.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { FILE_ROOTS, FIXTURE_NOW, fileRootGrants, PERSONA } from "../src/fixtures/index.ts";
import { displayPath, type FileRef, FilesPane } from "../src/screens/files/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const NOW = Date.parse(FIXTURE_NOW);

function setup(
  props: Partial<Parameters<typeof FilesPane>[0]> = {},
  edit: (w: FixtureWorld) => void = (w) => {
    w.settings["permissions.policy"] = { folders: fileRootGrants() };
  },
) {
  let gw: MockGateway | null = null;
  const renderViewer = vi.fn((file: FileRef) => <p>viewer for {file.name}</p>);
  render(
    <StoryWorld edit={edit} onGateway={(g) => (gw = g)}>
      <FilesPane now={NOW} renderViewer={renderViewer} {...props} />
    </StoryWorld>,
  );
  return {
    renderViewer,
    gateway: () => {
      if (gw === null) throw new Error("gateway not ready");
      return gw;
    },
  };
}

describe("FilesPane", () => {
  it("shows granted folders with their access and previews a picked file", async () => {
    const { renderViewer } = setup();
    const tree = screen.getByRole("navigation", { name: "Shared folders" });
    const documents = await within(tree).findByRole("button", { name: /~\/Documents/ });
    expect(documents.getAttribute("aria-expanded")).toBe("true");
    expect(within(documents).getByText("ro")).toBeTruthy();
    expect(within(tree).getByRole("button", { name: /~\/Projects\/psyche/ })).toBeTruthy();
    // Folders first, then files; a link is listed but not openable.
    const trips = await within(tree).findByRole("button", { name: "Trips" });
    expect(within(tree).getByText("old-link").closest("button")).toBeNull();
    await userEvent.click(trips);
    await userEvent.click(await within(tree).findByRole("button", { name: "lisbon.md" }));
    const preview = screen.getByRole("region", { name: "Preview of lisbon.md" });
    expect(within(preview).getByRole("heading", { name: "lisbon.md" })).toBeTruthy();
    expect(within(preview).getByText("viewer for lisbon.md")).toBeTruthy();
    expect(renderViewer).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: `${FILE_ROOTS.documents}/Trips/lisbon.md`, size: 54 }),
    );
    expect(
      within(tree).getByRole("button", { name: "lisbon.md" }).getAttribute("aria-current"),
    ).toBe("true");
  });

  it("lists Library items with their Library path", async () => {
    const { renderViewer } = setup();
    const tree = screen.getByRole("navigation", { name: "Shared folders" });
    const library = within(tree).getByRole("button", { name: /Library/ });
    await userEvent.click(library);
    const items = within(library.closest("li") as HTMLElement);
    await userEvent.click(await items.findByRole("button", { name: "permission-slip.pdf" }));
    expect(renderViewer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        libraryPath: "documents/permission-slip.pdf",
        libraryItem: expect.objectContaining({ name: "permission-slip.pdf" }),
      }),
    );
  });

  it("opens the file a view.open target names", async () => {
    setup({ target: `${FILE_ROOTS.project}/README.md` });
    expect(await screen.findByRole("region", { name: "Preview of README.md" })).toBeTruthy();
  });

  it("offers to share a folder when none is shared", async () => {
    const onShareFolder = vi.fn();
    setup({ onShareFolder }, () => undefined);
    expect(await screen.findByText(`No folders are shared with ${PERSONA.name}.`)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Share a folder" }));
    expect(onShareFolder).toHaveBeenCalled();
  });

  it("says when a folder stopped being shared", async () => {
    const { gateway } = setup();
    const tree = screen.getByRole("navigation", { name: "Shared folders" });
    await within(tree).findByRole("button", { name: "Trips" });
    // The owner revokes the project folder; the pane's copy of the setting is still old.
    gateway().world.settings["permissions.policy"] = { folders: [fileRootGrants()[0]] };
    await userEvent.click(within(tree).getByRole("button", { name: /~\/Projects\/psyche/ }));
    expect(await within(tree).findByText(/This folder is no longer shared\./)).toBeTruthy();
  });

  it("labels home folders with a tilde", () => {
    expect(displayPath("/Users/ada/Documents")).toBe("~/Documents");
    expect(displayPath("/home/ada")).toBe("~");
    expect(displayPath("/Volumes/Work")).toBe("/Volumes/Work");
  });
});

describe("readFileBytes", () => {
  const chunked = (content: Uint8Array, etags: string[] = []): GatewayCall => {
    let calls = 0;
    return (async (_method: string, params: { offset?: number }) => {
      const offset = params.offset ?? 0;
      const end = Math.min(content.length, offset + FILE_CHUNK_BYTES);
      const etag = etags[calls] ?? "e1";
      calls += 1;
      const r: MethodResult<"files.read"> = {
        name: "big.bin",
        mime: "application/octet-stream",
        modifiedAt: FIXTURE_NOW,
        etag,
        size: content.length,
        offset,
        bytes: toBase64(content.subarray(offset, end)),
        nextOffset: end < content.length ? end : null,
      };
      return r;
    }) as GatewayCall;
  };

  it("joins chunks into the whole file", async () => {
    const content = new Uint8Array(FILE_CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
    const r = await readFileBytes(chunked(content), { path: "/x/big.bin" });
    expect(r.bytes).toEqual(content);
    expect(r.name).toBe("big.bin");
  });

  it("refuses a file that changes while loading, or is too large", async () => {
    const content = new Uint8Array(FILE_CHUNK_BYTES + 1);
    await expect(
      readFileBytes(chunked(content, ["e1", "e2"]), { path: "/x/big.bin" }),
    ).rejects.toThrow("changed while it was loading");
    await expect(
      readFileBytes(chunked(content), { path: "/x/big.bin" }, { maxBytes: 1024 }),
    ).rejects.toThrow("previews stop at");
  });

  it("reads through the mock Gateway's granted folders", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld
        edit={(w) => {
          w.settings["permissions.policy"] = { folders: fileRootGrants() };
        }}
        onGateway={(g) => (gw = g)}
      >
        <span />
      </StoryWorld>,
    );
    await waitFor(() => expect(gw).not.toBeNull());
    const g = gw as unknown as MockGateway;
    const call = ((m: string, p: unknown) => g.request(m as never, p as never)) as GatewayCall;
    const r = await readFileBytes(call, { path: `${FILE_ROOTS.project}/README.md` });
    expect(new TextDecoder().decode(r.bytes)).toContain("# Psyche");
    expect(r.mime).toBe("text/markdown");
    await expect(readFileBytes(call, { path: "/etc/passwd" })).rejects.toThrow(
      "outside every granted folder",
    );
  });
});
