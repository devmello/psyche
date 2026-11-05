import type { SpeechEngineStatus, SpeechWhisperSetup } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setUiPlatform } from "../src/lib/platform.ts";
import { SpeechModelPanel } from "../src/screens/settings/SpeechModel.tsx";

afterEach(() => setUiPlatform(undefined));

const whisper = (over: Partial<SpeechWhisperSetup> = {}): SpeechWhisperSetup => ({
  state: "missing",
  model: { id: "whisper-base.en", sizeBytes: 147_964_211, present: false },
  runtime: {
    id: "whisper-runtime-b5454-win-x64",
    release: "b5454",
    sizeBytes: 8_928_640,
    present: false,
  },
  downloadBytes: 156_892_851,
  server: "stopped",
  ...over,
});

const status = (
  w: SpeechWhisperSetup | null,
  active: string | null = "mac-node",
): SpeechEngineStatus => ({
  order: ["whisper", "mac-node", "web-speech"],
  dictation: [],
  active,
  whisper: w,
});

describe("the speech model offer (Settings → Voice & dictation, onboarding)", () => {
  it("shows nothing where the Gateway does not provision whisper (the Mac)", () => {
    const { container } = render(<SpeechModelPanel status={status(null)} />);
    expect(container.innerHTML).toBe("");
  });

  it("offers the one-click download with its size, in Windows words on Windows", async () => {
    setUiPlatform("windows");
    const onDownload = vi.fn();
    render(<SpeechModelPanel status={status(whisper())} onDownload={onDownload} />);
    expect(screen.getByText(/Windows speech recognition \(SAPI\)/)).toBeTruthy();
    expect(screen.getByText(/Audio never leaves this PC/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Download the speech model (157 MB) for better dictation",
      }),
    );
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("shows the download's progress", () => {
    render(
      <SpeechModelPanel
        status={status(
          whisper({ state: "downloading", receivedBytes: 42_000_000, totalBytes: 156_892_851 }),
        )}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Downloading the speech model: 42 of 157 MB",
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says why a download failed and offers to try again", () => {
    render(
      <SpeechModelPanel
        status={status(whisper({ state: "error", error: "checksum mismatch for whisper-base.en" }))}
        onDownload={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/checksum mismatch/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("names the engine once installed, and a missing Visual C++ runtime", () => {
    setUiPlatform("windows");
    const ready = whisper({ state: "ready", downloadBytes: 0 });
    const { rerender } = render(<SpeechModelPanel status={status(ready, "whisper")} />);
    expect(screen.getByText("Whisper (base.en) on this PC")).toBeTruthy();
    expect(screen.getByText(/audio never leaves the PC/)).toBeTruthy();
    rerender(<SpeechModelPanel status={status(ready, "mac-node")} />);
    expect(screen.getByText(/puts another engine first/)).toBeTruthy();
    rerender(
      <SpeechModelPanel
        status={status({ ...ready, serverError: "vcredist_missing" }, "mac-node")}
      />,
    );
    expect(screen.getByText(/Visual C\+\+ Redistributable/)).toBeTruthy();
  });
});
