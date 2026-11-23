import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AboutPanel } from "../src/screens/settings/AboutSection.tsx";
import type { AboutInfo, UpdatePort, UpdateStatusView } from "../src/screens/settings/types.ts";
import { UpdateBanner } from "../src/shell/UpdateBanner.tsx";

const info: AboutInfo = {
  appVersion: "0.3.0",
  gatewayVersion: "0.3.0",
  protocolVersion: 1,
  platform: "macOS 27.0.1 · Apple silicon",
  home: "/Users/owner/.psyche",
};

/** A port whose status the test sets; `push` simulates main's change event. */
function fakePort(initial: UpdateStatusView) {
  let listener: ((s: UpdateStatusView) => void) | undefined;
  const port: UpdatePort & { push(s: UpdateStatusView): void } = {
    status: vi.fn(async () => initial),
    subscribe: vi.fn((cb) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    }),
    restart: vi.fn(async () => undefined),
    push: (s) => listener?.(s),
  };
  return port;
}

describe("About shows the app's real update state", () => {
  it("says Up to date when no newer release is published", async () => {
    render(<AboutPanel info={info} showUpdates update={fakePort({ state: "none" })} />);
    expect(await screen.findByText("Up to date")).toBeTruthy();
  });

  it("says the release is ready and offers Restart to update", async () => {
    const port = fakePort({ state: "ready", release: "0.4.0", mandatory: false });
    render(<AboutPanel info={info} showUpdates update={port} />);
    expect(await screen.findByText("Psyche 0.4.0 is ready")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(port.restart).toHaveBeenCalledOnce();
  });

  it("marks a required release as required", async () => {
    const port = fakePort({ state: "ready", release: "0.4.0", mandatory: true });
    render(<AboutPanel info={info} showUpdates update={port} />);
    expect(await screen.findByText("Psyche 0.4.0 is ready (required)")).toBeTruthy();
  });

  it("says why an update was refused", async () => {
    const port = fakePort({ state: "refused", reason: "signature did not verify" });
    render(<AboutPanel info={info} showUpdates update={port} />);
    expect(await screen.findByText("Update refused: signature did not verify")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
  });

  it("shows checking while a verified download is in flight", async () => {
    render(<AboutPanel info={info} showUpdates update={fakePort({ state: "checking" })} />);
    expect(await screen.findByText("Checking for updates…")).toBeTruthy();
  });

  it("shows no status row on the web (no port)", () => {
    render(<AboutPanel info={info} showUpdates={false} />);
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("Up to date")).toBeNull();
  });

  it("updates when main reports a change", async () => {
    const port = fakePort({ state: "checking" });
    render(<AboutPanel info={info} showUpdates update={port} />);
    await screen.findByText("Checking for updates…");
    port.push({ state: "ready", release: "0.5.0", mandatory: false });
    expect(await screen.findByText("Psyche 0.5.0 is ready")).toBeTruthy();
  });
});

describe("the sidebar update banner", () => {
  it("shows the version, Restart to update and a dismiss when ready", async () => {
    const port = fakePort({ state: "ready", release: "0.4.0", mandatory: false });
    render(<UpdateBanner port={port} />);
    expect(await screen.findByText("Psyche 0.4.0 is ready")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(port.restart).toHaveBeenCalledOnce();
  });

  it("hides until the next launch once dismissed", async () => {
    const port = fakePort({ state: "ready", release: "0.4.0", mandatory: false });
    render(<UpdateBanner port={port} />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByTestId("update-banner")).toBeNull();
  });

  it("renders nothing when no update is ready, or on the web", async () => {
    const { unmount } = render(<UpdateBanner port={fakePort({ state: "none" })} />);
    await waitFor(() => expect(screen.queryByTestId("update-banner")).toBeNull());
    unmount();
    render(<UpdateBanner />);
    expect(screen.queryByTestId("update-banner")).toBeNull();
  });

  it("shows the refusal when Restart to update fails", async () => {
    const port = fakePort({ state: "ready", release: "0.4.0", mandatory: false });
    port.restart = vi.fn(async () => {
      throw new Error("no verified update is ready to install");
    });
    render(<UpdateBanner port={port} />);
    await userEvent.click(await screen.findByRole("button", { name: "Restart to update" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
