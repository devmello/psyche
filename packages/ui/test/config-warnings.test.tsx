import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { RemoteAccessGroup } from "../src/screens/settings/RemoteAccessGroup.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings shows config.json keys the Gateway ignores, so a misspelt setting is noticed. */

type Handlers = Record<string, (p: unknown) => unknown>;

function show(configWarnings?: string[]) {
  return render(
    <StoryWorld
      onGateway={(gw: MockGateway) => {
        const handlers = (gw as unknown as { handlers: Handlers }).handlers;
        const original = handlers["gateway.info"];
        handlers["gateway.info"] = (p) => ({
          ...(original?.(p) as object),
          ...(configWarnings === undefined ? {} : { configWarnings }),
        });
      }}
    >
      <RemoteAccessGroup />
    </StoryWorld>,
  );
}

describe("config warnings in Settings", () => {
  it("names the keys that are being ignored", async () => {
    show(["gateway.quantumFlux", "future"]);
    const note = await screen.findByText(/does not know, so it ignores them/);
    expect(note.textContent).toContain("gateway.quantumFlux, future");
    expect(note.textContent).toContain("check the spelling");
  });

  it("says nothing when every key is understood", async () => {
    show();
    await screen.findByText("Public address");
    expect(screen.queryByText(/does not know, so it ignores them/)).toBeNull();
  });
});
