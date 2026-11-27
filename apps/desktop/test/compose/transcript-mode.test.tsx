// @vitest-environment happy-dom
import { GatewayProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  levelOf,
  modeOf,
  TRANSCRIPT_MODE_KEY,
  TranscriptModeBar,
  useTranscriptMode,
} from "../../src/compose/transcript-mode.tsx";

afterEach(cleanup);

function Harness() {
  const [level, setLevel] = useTranscriptMode();
  return <TranscriptModeBar level={level} onChange={setLevel} />;
}

describe("transcript view modes (E11)", () => {
  it("maps modes to disclosure levels with Thinking as the default", () => {
    expect(levelOf(undefined)).toBe(1);
    expect(levelOf("normal")).toBe(0);
    expect(levelOf("verbose")).toBe(2);
    expect(levelOf("junk")).toBe(1);
    expect(modeOf(0)).toBe("normal");
    expect(modeOf(2)).toBe("verbose");
  });

  it("reads the persisted mode and writes ui.transcriptMode on change", async () => {
    const gw = new MockGateway();
    await gw.request(
      "settings.set",
      { key: TRANSCRIPT_MODE_KEY, value: "verbose" },
      { idempotencyKey: "seed" },
    );
    render(
      <GatewayProvider client={gw}>
        <Harness />
      </GatewayProvider>,
    );
    const verbose = screen.getByRole("radio", { name: "Verbose" }) as HTMLInputElement;
    await waitFor(() => expect(verbose.checked).toBe(true));
    fireEvent.click(screen.getByRole("radio", { name: "Normal" }));
    await waitFor(() =>
      expect(
        gw.calls.some(
          (c) =>
            c.method === "settings.set" &&
            JSON.stringify(c.params) ===
              JSON.stringify({ key: TRANSCRIPT_MODE_KEY, value: "normal" }),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect((screen.getByRole("radio", { name: "Normal" }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
  });
});
