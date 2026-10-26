import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement, ReactNode } from "react";
import {
  type ScreenAskCaptureView,
  ScreenAskView,
  type ScreenAskViewProps,
} from "./ScreenAskView.tsx";

/**
 * Ask about my screen (docs/design/screen-ask-2026.md): the ask panel before sending (window and
 * region captures, pinned, text only, refused), while answering, and done.
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

function Frame({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="bg-canvas p-6" style={{ width: 528 }}>
      {children}
    </div>
  );
}

function Panel(p: Partial<ScreenAskViewProps>): ReactElement {
  return (
    <Frame>
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
    </Frame>
  );
}

const meta: Meta<typeof Panel> = { title: "Chat/Screen ask", component: Panel };
export default meta;
type Story = StoryObj<typeof Panel>;

export const Window: Story = { args: { text: "What does this error mean?" } };
export const Capturing: Story = {
  args: {
    capture: { status: "capturing", mode: "window", thumbnail: null, appName: null, image: "auto" },
  },
};
export const RegionPinned: Story = {
  args: { capture: ready({ mode: "region", image: "pinned" }), text: "Summarise this chart" },
};
export const TextOnly: Story = {
  args: {
    capture: ready({ thumbnail: null, refusal: "permission_missing" }),
    onAllowCapture: noop,
    destination: "current",
  },
};
export const Excluded: Story = {
  args: { capture: ready({ thumbnail: null, appName: "1Password", refusal: "app_excluded" }) },
};
export const Listening: Story = {
  args: { dictation: { phase: "listening", partial: "reply to this saying thanks", toggle: noop } },
};
export const Answering: Story = {
  args: {
    text: "What does this error mean?",
    answer: { status: "streaming", text: "" },
    onOpen: noop,
  },
};
export const Answered: Story = {
  args: {
    text: "What does this error mean?",
    answer: {
      status: "done",
      text: "The build can't find **`libfoo`**. Install it with `brew install foo`, then rerun the build.",
    },
    onOpen: noop,
  },
};
