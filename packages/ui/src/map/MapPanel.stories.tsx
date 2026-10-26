import type { Meta, StoryObj } from "@storybook/react-vite";
import { MAP_FIXTURE } from "../fixtures/canvas.ts";
import { StoryWorld } from "../stories/harness.tsx";
import { MapPanel } from "./MapPanel.tsx";
import { DEFAULT_STYLE_DARK, DEFAULT_STYLE_LIGHT, parseMapContent } from "./map-model.ts";

/** The chat map widget (inline card and canvas). Stories without tiles show the list fallback. */

const meta = { title: "Chat/Map" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const map = parseMapContent(MAP_FIXTURE);
if (map === null) throw new Error("bad map fixture");
const on = { tiles: true, light: DEFAULT_STYLE_LIGHT, dark: DEFAULT_STYLE_DARK, isDefault: true };

export const InlineTilesOff: Story = {
  render: () => (
    <StoryWorld>
      <div className="w-[520px]">
        <MapPanel map={map} variant="inline" source={{ ...on, tiles: false }} />
      </div>
    </StoryWorld>
  ),
};

export const InlineTilesFailed: Story = {
  render: () => (
    <StoryWorld>
      <div className="w-[520px]">
        <MapPanel map={map} variant="inline" source={on} forceFailed />
      </div>
    </StoryWorld>
  ),
};

export const FullTilesOff: Story = {
  render: () => (
    <StoryWorld>
      <div className="h-[420px] w-[620px]">
        <MapPanel map={map} variant="full" source={{ ...on, tiles: false }} />
      </div>
    </StoryWorld>
  ),
};

/** Needs network for OpenFreeMap tiles; no baseline. */
export const InlineLive: Story = {
  tags: ["no-visual"],
  render: () => (
    <StoryWorld>
      <div className="w-[520px]">
        <MapPanel map={map} variant="inline" source={on} />
      </div>
    </StoryWorld>
  ),
};
