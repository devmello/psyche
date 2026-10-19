// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerItem } from "../src/core/types.ts";
import { PdfViewer } from "../src/react/PdfViewer.tsx";
import { acroFormPdf, manyPagePdf, xfaPdf } from "./fixtures/pdf.ts";

afterEach(cleanup);

const item = (name: string): ViewerItem => ({
  id: name,
  name,
  mime: "application/pdf",
  provenance: "untrusted",
});

describe("PdfViewer", () => {
  it("virtualizes a 100-page PDF: only a few pages are mounted", async () => {
    const bytes = manyPagePdf(100);
    render(<PdfViewer item={item("big.pdf")} load={async () => bytes} />);
    await screen.findByLabelText("Page number");
    expect(screen.getByText(/of 100/)).toBeTruthy();
    const mounted = () => screen.getByTestId("pdf-pages").querySelectorAll("[data-page]");
    await waitFor(() => expect(mounted().length).toBeGreaterThan(0));
    expect(mounted().length).toBeLessThanOrEqual(8);
    // Jump to page 60: the window moves, the count stays small.
    fireEvent.change(screen.getByLabelText("Page number"), { target: { value: "60" } });
    await waitFor(() =>
      expect([...mounted()].some((el) => el.getAttribute("data-page") === "60")).toBe(true),
    );
    expect(mounted().length).toBeLessThanOrEqual(8);
  });

  it("searches, zooms and reports page state", async () => {
    const onPageStateChange = vi.fn();
    render(
      <PdfViewer
        item={item("s.pdf")}
        load={async () => manyPagePdf(50)}
        onPageStateChange={onPageStateChange}
      />,
    );
    const search = await screen.findByLabelText("Search in document");
    fireEvent.keyDown(search, { key: "Enter", target: { value: "needle" } });
    fireEvent.change(search, { target: { value: "needle" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await screen.findByText("1 / 1");
    await waitFor(() =>
      expect(onPageStateChange).toHaveBeenCalledWith(expect.objectContaining({ page: 42 })),
    );
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(screen.getByLabelText("Zoom level").textContent).toBe("125%");
  });

  it("lists AcroForm fields, marks agent proposals, applies a fill preview", async () => {
    const onSave = vi.fn();
    render(
      <PdfViewer
        item={item("slip.pdf")}
        load={acroFormPdf}
        proposedValues={{ child_name: "Ada Lin" }}
        onSaveToLibrary={onSave}
      />,
    );
    const list = await screen.findByLabelText("Form fields");
    expect(within(list).getByText(/5 fields/)).toBeTruthy();
    const nameRow = within(list).getByText("child_name").closest("li");
    expect(nameRow?.getAttribute("data-source")).toBe("agent");
    expect((within(nameRow as HTMLElement).getByRole("textbox") as HTMLInputElement).value).toBe(
      "Ada Lin",
    );
    const school = within(within(list).getByText("school").closest("li") as HTMLElement).getByRole(
      "textbox",
    ) as HTMLInputElement;
    expect(school.readOnly).toBe(true);
    await waitFor(() => expect(document.querySelectorAll(".psy-pdf__field").length).toBe(5));
    fireEvent.click(within(list).getByText("Apply fill"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      name: "slip (filled).pdf",
      mime: "application/pdf",
    });
  });

  it("shows a clear state for XFA forms", async () => {
    render(<PdfViewer item={item("xfa.pdf")} load={async () => xfaPdf()} />);
    expect(await screen.findByText("XFA forms are not supported")).toBeTruthy();
  });

  it("shows an error for broken files", async () => {
    render(
      <PdfViewer item={item("bad.pdf")} load={async () => new TextEncoder().encode("nope")} />,
    );
    expect(await screen.findByText("This PDF could not be opened")).toBeTruthy();
  });
});

describe("PdfViewer teardown", () => {
  it("unmounting while pages are still loading leaves no unhandled rejection", async () => {
    const bytes = manyPagePdf(100);
    const { unmount } = render(<PdfViewer item={item("t.pdf")} load={async () => bytes} />);
    const pageInput = await screen.findByLabelText("Page number");
    // Jump far so a new window of pages starts loading, then close the document at once.
    fireEvent.change(pageInput, { target: { value: "80" } });
    unmount();
    // Give the worker time to reject the in-flight getPage calls; Vitest fails the run on any
    // unhandled rejection.
    await new Promise((r) => setTimeout(r, 300));
  });
});
