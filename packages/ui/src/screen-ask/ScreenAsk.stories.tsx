import type { Message } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement, ReactNode } from "react";
import { createFixtureWorld, IDS } from "../fixtures/index.ts";
import { withWorld } from "../stories/harness.tsx";
import {
  type ScreenAskCaptureView,
  ScreenAskView,
  type ScreenAskViewProps,
} from "./ScreenAskView.tsx";

/**
 * Ask about my screen (docs/design/screen-ask-2026.md, "Redesign: Siri-simple"): the collapsed bar,
 * listening, thinking, and the answer growing downward with the chat's own cards. Every frame sits
 * on a busy wallpaper, as the real panel does, to show the surface reads over anything.
 */

const noop = () => {};
// A 4×3 grey thumbnail, so stories render the same everywhere.
const THUMB =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='36'><rect width='48' height='36' fill='%23889'/><rect x='4' y='4' width='40' height='6' fill='%23ccd'/></svg>";

const ready = (c: Partial<ScreenAskCaptureView> = {}): ScreenAskCaptureView => ({
  status: "ready",
  mode: "window",
  thumbnail: THUMB,
  appName: "Safari",
  image: "auto",
  ...c,
});

const world = createFixtureWorld();
const results = world.messages.find((m) => m.id === IDS.messages.dentistResults);
if (results === undefined) throw new Error("fixture message missing");
/** An agent reply with text and an itinerary artifact card, as the main chat draws it. */
const withCard: Message = {
  ...results,
  blocks: [
    { type: "text", md: "Tuesday still has room. I laid the day out below." },
    ...results.blocks.filter((b) => b.type === "artifact"),
  ],
};
const textOnly: Message = {
  ...results,
  blocks: [
    {
      type: "text",
      md: "The build can't find **`libfoo`**. Install it with `brew install foo`, then rerun the build.",
    },
  ],
};

/** A bright, busy stand-in for a wallpaper: stripes and a hot spot behind the panel. */
function Wallpaper({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      className="p-6"
      style={{
        width: 608,
        background:
          "radial-gradient(circle at 70% 30%, #ffd166 0 18%, transparent 19%), repeating-linear-gradient(135deg, #ef476f 0 24px, #118ab2 24px 48px, #f8f8f8 48px 72px)",
      }}
    >
      {children}
    </div>
  );
}

function Panel(p: Partial<ScreenAskViewProps>): ReactElement {
  return (
    <Wallpaper>
      <ScreenAskView
        capture={ready()}
        text=""
        onText={noop}
        onSubmit={noop}
        onCancel={noop}
        onDrop={noop}
        onTogglePin={noop}
        onRecapture={noop}
        onSelectArea={noop}
        destination="new"
        onDestination={noop}
        dictation={{ phase: "idle", toggle: noop }}
        {...p}
      />
    </Wallpaper>
  );
}

const meta: Meta<typeof Panel> = {
  title: "Chat/Screen ask",
  component: Panel,
  decorators: [withWorld()],
};
export default meta;
type Story = StoryObj<typeof Panel>;

/** The collapsed bar: orb, chip, input, mic, send. */
export const Collapsed: Story = { args: { text: "What does this error mean?" } };
export const Empty: Story = {};
export const Capturing: Story = {
  args: {
    capture: { status: "capturing", mode: "window", thumbnail: null, appName: null, image: "auto" },
  },
};
export const RegionPinned: Story = {
  args: { capture: ready({ mode: "region", image: "pinned" }), text: "Summarise this chart" },
};
export const Listening: Story = {
  args: { dictation: { phase: "listening", partial: "reply to this saying thanks", toggle: noop } },
};
export const Thinking: Story = {
  args: {
    text: "What does this error mean?",
    answer: { status: "streaming", messages: [] },
    onOpen: noop,
  },
};
export const Answering: Story = {
  args: {
    text: "What does this error mean?",
    answer: {
      status: "streaming",
      messages: [],
      streamingText: "The build can't find **`libfoo`**. Install it with `brew install",
    },
    onOpen: noop,
  },
};
export const AnsweredText: Story = {
  args: {
    text: "What does this error mean?",
    answer: { status: "done", messages: [textOnly] },
    onOpen: noop,
  },
};
/** The reply holds the chat's own Card shell: an itinerary artifact under the text. */
export const AnsweredWithCard: Story = {
  args: {
    text: "Is Tuesday free at the dentist?",
    answer: { status: "done", messages: [withCard] },
    onOpen: noop,
  },
};
export const Failed: Story = {
  args: { text: "hi", answer: { status: "failed", messages: [] }, onOpen: noop },
};
export const MoreOptions: Story = {
  args: { text: "Summarise this", destination: "current" },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button[aria-label="More"]')?.click();
  },
};
export const TextOnly: Story = {
  args: {
    capture: ready({ thumbnail: null, refusal: "permission_missing" }),
    onAllowCapture: noop,
  },
};
export const Excluded: Story = {
  args: { capture: ready({ thumbnail: null, appName: "1Password", refusal: "app_excluded" }) },
};
export const Voice: Story = {
  args: { capture: undefined, placeholder: "Ask Psyche anything…" },
};
