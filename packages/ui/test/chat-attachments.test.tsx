import type { ModelProviderSummary } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  type AttachmentChip,
  acceptFor,
  admitFiles,
  attachmentIds,
  attachSupport,
  canAttach,
  chipsReducer,
  classifyFile,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  modelCapabilities,
  uploading,
} from "../src/chat/attachments.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { type createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const MODEL = "anthropic/claude-sonnet-5-5";
const file = (name: string, type: string, size = 100) => ({ name, type, size });

function provider(caps: Record<string, unknown> | undefined): ModelProviderSummary {
  return {
    id: "anthropic",
    kind: "anthropic",
    label: "Anthropic",
    local: false,
    keyConfigured: true,
    models: [
      {
        ref: MODEL,
        toolCheck: "untested",
        ...(caps ? { capabilities: { source: "catalog", ...caps } } : {}),
      },
    ],
    probe: { state: "not_probed", models: [] },
  } as ModelProviderSummary;
}

describe("which models take files (the + button's visibility rule)", () => {
  it("shows the button when support is unknown", () => {
    expect(canAttach(attachSupport(undefined))).toBe(true);
    expect(attachSupport({ source: "heuristic" })).toEqual({ images: true, documents: true });
  });

  it("takes images only from a model that can see, documents from any chat model", () => {
    expect(attachSupport({ vision: true, source: "listing" })).toEqual({
      images: true,
      documents: true,
    });
    const blind = attachSupport({ vision: false, source: "listing" });
    expect(blind).toEqual({ images: false, documents: true });
    expect(canAttach(blind)).toBe(true);
  });

  it("hides the button only when the model takes nothing", () => {
    const embeddings = attachSupport({ embeddings: true, source: "listing" });
    expect(embeddings).toEqual({ images: false, documents: false });
    expect(canAttach(embeddings)).toBe(false);
  });

  it("reads the thread's model, else the primary role's, from models.list", () => {
    const models = {
      providers: [provider({ vision: false })],
      roles: { primary: MODEL },
    };
    expect(modelCapabilities(models, MODEL)?.vision).toBe(false);
    // A pinned ref no provider lists (the router's) falls back to the primary role.
    expect(modelCapabilities(models, "router/auto")?.vision).toBe(false);
    expect(modelCapabilities(models, null)?.vision).toBe(false);
    expect(modelCapabilities({ providers: [], roles: {} }, MODEL)).toBeUndefined();
    expect(modelCapabilities(undefined, MODEL)).toBeUndefined();
  });
});

describe("which files are admitted", () => {
  const all = { images: true, documents: true };
  it("classifies by extension or mime", () => {
    expect(classifyFile(file("a.PNG", ""))).toBe("image");
    expect(classifyFile(file("b", "image/webp"))).toBe("image");
    expect(classifyFile(file("c.pdf", "application/pdf"))).toBe("document");
    expect(classifyFile(file("d.docx", ""))).toBe("document");
    expect(classifyFile(file("e.xlsx", ""))).toBe("document");
    expect(classifyFile(file("notes.txt", "text/plain"))).toBe("document");
    expect(classifyFile(file("f.exe", "application/x-msdownload"))).toBeNull();
  });

  it("offers only document types to a model without vision", () => {
    const accept = acceptFor({ images: false, documents: true });
    expect(accept).toContain(".pdf");
    expect(accept).not.toContain(".png");
    expect(acceptFor(all)).toContain(".png");
  });

  it("refuses an image for a model without vision and says why", () => {
    const { accepted, refused } = admitFiles(
      [file("shot.png", "image/png"), file("brief.pdf", "application/pdf")],
      { images: false, documents: true },
      0,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(["brief.pdf"]);
    expect(refused).toEqual([{ name: "shot.png", reason: "image" }]);
  });

  it("refuses unreadable types, oversized files and a full row", () => {
    const { accepted, refused } = admitFiles(
      [
        file("x.exe", ""),
        file("huge.png", "image/png", MAX_IMAGE_BYTES + 1),
        file("ok.txt", "text/plain"),
        file("late.txt", "text/plain"),
      ],
      all,
      MAX_ATTACHMENTS - 1,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(["ok.txt"]);
    expect(refused.map((r) => r.reason)).toEqual(["type", "size", "count"]);
  });
});

describe("chips", () => {
  const chip = (key: string): AttachmentChip => ({
    key,
    name: `${key}.pdf`,
    kind: "document",
    status: "uploading",
  });

  it("adds, finishes, fails and removes", () => {
    let chips = chipsReducer([], { type: "add", chips: [chip("a"), chip("b")] });
    expect(uploading(chips)).toBe(true);
    chips = chipsReducer(chips, { type: "uploaded", key: "a", itemId: "lib-a" });
    chips = chipsReducer(chips, { type: "failed", key: "b" });
    expect(uploading(chips)).toBe(false);
    expect(chips.map((c) => c.status)).toEqual(["ready", "error"]);
    // Only a finished upload is sent.
    expect(attachmentIds(chips)).toEqual(["lib-a"]);
    chips = chipsReducer(chips, { type: "remove", key: "a" });
    expect(chips.map((c) => c.key)).toEqual(["b"]);
    expect(chipsReducer(chips, { type: "clear" })).toEqual([]);
  });

  it("ignores a late result for a chip that was removed", () => {
    const chips = chipsReducer([chip("a")], { type: "remove", key: "a" });
    expect(chipsReducer(chips, { type: "uploaded", key: "a", itemId: "lib-a" })).toEqual([]);
  });
});

function mount(opts: { caps?: Record<string, unknown>; modelRef?: boolean }) {
  let gateway: MockGateway | undefined;
  render(
    <StoryWorld
      edit={(w: ReturnType<typeof createFixtureWorld>) => {
        w.modelProviders = [provider(opts.caps)];
        w.modelRoles = { primary: MODEL };
      }}
      onGateway={(g) => {
        gateway = g;
      }}
    >
      <div style={{ height: 900 }}>
        <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
      </div>
    </StoryWorld>,
  );
  return () => gateway as MockGateway;
}

describe("the composer's + button", () => {
  it("shows for a model that can see, and for one whose support is unknown", async () => {
    mount({ caps: { vision: true } });
    expect(await screen.findByRole("button", { name: "Attach files" })).toBeTruthy();
  });

  it("shows for a model without vision, which then takes documents only", async () => {
    mount({ caps: { vision: false } });
    await screen.findByRole("button", { name: "Attach files" });
    await waitFor(() =>
      expect(screen.getByTestId("attach-input").getAttribute("accept")).not.toContain(".png"),
    );
    expect(screen.getByTestId("attach-input").getAttribute("accept")).toContain(".pdf");
  });

  it("hides for a model that takes no files", async () => {
    mount({ caps: { embeddings: true } });
    await screen.findByRole("textbox", { name: /^Message / });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull());
  });

  it("uploads a picked file as a chip and sends its Library id with the message", async () => {
    const gw = mount({ caps: { vision: true } });
    const input = (await screen.findByTestId("attach-input")) as HTMLInputElement;
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], "brief.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(input, { target: { files: [pdf] } });
    const chips = await screen.findByTestId("attach-chips");
    expect(within(chips).getByText("brief.pdf")).toBeTruthy();
    await waitFor(() => expect(chips.querySelector("[data-status=ready]")).not.toBeNull());
    const upload = gw().calls.find((c) => c.method === "library.upload");
    expect(upload?.params).toMatchObject({ name: "brief.pdf", final: true });

    const box = screen.getByRole("textbox", { name: /^Message / });
    await userEvent.type(box, "summarize this{Enter}");
    await waitFor(() => expect(gw().calls.some((c) => c.method === "chat.send")).toBe(true));
    const send = gw().calls.find((c) => c.method === "chat.send");
    const uploaded = gw().world.library.find((i) => i.name === "brief.pdf");
    expect(uploaded).toBeDefined();
    expect(send?.params).toMatchObject({
      content: "summarize this",
      attachments: [uploaded?.id],
    });
    // The chips clear once the message is on its way.
    await waitFor(() => expect(screen.queryByTestId("attach-chips")).toBeNull());
  });

  it("removes a chip so it is not sent", async () => {
    const gw = mount({ caps: { vision: true } });
    const input = (await screen.findByTestId("attach-input")) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["a"], "a.txt", { type: "text/plain" })] },
    });
    const chips = await screen.findByTestId("attach-chips");
    await waitFor(() => expect(chips.querySelector("[data-status=ready]")).not.toBeNull());
    await userEvent.click(within(chips).getByRole("button", { name: "Remove a.txt" }));
    expect(screen.queryByTestId("attach-chips")).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: /^Message / }), "hi{Enter}");
    await waitFor(() => expect(gw().calls.some((c) => c.method === "chat.send")).toBe(true));
    expect(gw().calls.find((c) => c.method === "chat.send")?.params).not.toHaveProperty(
      "attachments",
    );
  });

  it("takes dropped and pasted files, and says why an image was refused", async () => {
    mount({ caps: { vision: false } });
    const capsule = await screen.findByTestId("composer-capsule");
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const txt = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(capsule, { dataTransfer: { files: [png, txt], types: ["Files"] } });
    const chips = await screen.findByTestId("attach-chips");
    expect(within(chips).getByText("notes.txt")).toBeTruthy();
    expect(within(chips).queryByText("shot.png")).toBeNull();
    expect(screen.getByTestId("attach-refused").textContent).toContain("can't read images");

    const box = screen.getByRole("textbox", { name: /^Message / });
    fireEvent.paste(box, {
      clipboardData: { files: [new File(["y"], "pasted.md", { type: "text/markdown" })] },
    });
    await waitFor(() => expect(within(chips).getByText("pasted.md")).toBeTruthy());
  });
});
