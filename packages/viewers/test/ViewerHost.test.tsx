// @vitest-environment jsdom
import type { LibraryItem } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/index.ts";
import { ViewerHost } from "../src/react/ViewerHost.tsx";

afterEach(cleanup);
const enc = (s: string) => new TextEncoder().encode(s);

describe("ViewerHost", () => {
  it("resolves the viewer from the registry and lazy-loads it", async () => {
    render(
      <ViewerHost
        item={{ id: "a", name: "a.json", mime: "application/json", provenance: "trusted" }}
        load={async () => enc('{"x":1}')}
      />,
    );
    expect(await screen.findByLabelText("a.json tree")).toBeTruthy();
    expect(document.querySelector("[data-viewer='json']")).not.toBeNull();
  });

  it("lets the shell override a render kind", async () => {
    const Custom = () => <p>custom json</p>;
    render(
      <ViewerHost
        item={{ id: "a", name: "a.json", mime: "application/json", provenance: "trusted" }}
        load={async () => enc("{}")}
        components={{ json: Custom }}
      />,
    );
    expect(await screen.findByText("custom json")).toBeTruthy();
  });

  it("gates quarantined downloads behind a click", async () => {
    const libraryItem = { quarantined: true } as LibraryItem;
    const load = vi.fn(async () => enc("hello"));
    const onTrust = vi.fn();
    render(
      <ViewerHost
        item={{ id: "d", name: "d.txt", mime: "text/plain", provenance: "untrusted", libraryItem }}
        load={load}
        onTrust={onTrust}
      />,
    );
    expect(screen.getByText("Downloaded file")).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Trust this file"));
    expect(onTrust).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Open"));
    expect(await screen.findByLabelText("d.txt source")).toBeTruthy();
    expect(load).toHaveBeenCalled();
  });

  it("says when there is no viewer", () => {
    render(
      <ViewerHost
        item={{ id: "z", name: "z.bin", mime: "application/x-unknown", provenance: "trusted" }}
        load={async () => new Uint8Array()}
      />,
    );
    expect(screen.getByText("No preview for this file type")).toBeTruthy();
  });

  it("exports the public API", () => {
    for (const name of [
      "ViewerHost",
      "PdfViewer",
      "SheetViewer",
      "MarkdownEditor",
      "ArtifactFrame",
      "extractText",
      "createDefaultViewerRegistry",
      "buildArtifactSrcdoc",
      "artifactHostPage",
      "DocumentSession",
      "configurePdfJs",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });
});
