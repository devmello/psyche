// @vitest-environment happy-dom
import { GatewayProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ZoomSetting } from "../../src/compose/ZoomSetting.tsx";
import { ZOOM_KEY } from "../../src/compose/zoom.ts";

afterEach(cleanup);

describe("Settings → Appearance → Zoom", () => {
  it("shows the stored percentage and writes appearance.zoom", async () => {
    const gw = new MockGateway();
    await gw.request("settings.set", { key: ZOOM_KEY, value: 150 }, { idempotencyKey: "seed" });
    render(
      <GatewayProvider client={gw}>
        <ZoomSetting />
      </GatewayProvider>,
    );
    await screen.findByText("150 %");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() =>
      expect(
        gw.calls.some(
          (c) =>
            c.method === "settings.set" &&
            JSON.stringify(c.params) === JSON.stringify({ key: ZOOM_KEY, value: 175 }),
        ),
      ).toBe(true),
    );
    await screen.findByText("175 %");
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    await screen.findByText("100 %");
    expect(
      (screen.getByRole("button", { name: "Actual size" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
