import type { Meta, StoryObj } from "@storybook/react-vite";
import { t } from "../i18n/core.ts";
import { withWorld } from "../stories/harness.tsx";
import { StartupSplashView } from "./StartupSplashView.tsx";

/**
 * The startup splash (#595): a moth draws itself in ink, its wings open as Psyche wakes, then it
 * flies to the toolbar avatar. The visual suite renders every story in light and dark.
 */
const meta = {
  title: "Shell/Startup splash",
  component: StartupSplashView,
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
  args: { line: { tone: "progress", text: t("web.splash.starting"), step: 0 } },
} satisfies Meta<typeof StartupSplashView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Starting: Story = {};

/** Connecting: the last stage before ready, wings nearly open. */
export const Connecting: Story = {
  args: { line: { tone: "progress", text: t("web.splash.connecting"), step: 2 } },
};

/** Reduced motion: the same drawing, static, no flight; one crossfade out. */
export const ReducedMotion: Story = {
  globals: { motion: "reduced" },
  args: { line: { tone: "progress", text: t("web.splash.waiting"), step: 1 } },
};

/** A slow start: after a few seconds it says so, and the app is one click away. */
export const SlowStart: Story = {
  args: {
    line: { tone: "progress", text: t("web.splash.helper"), step: 2 },
    slow: true,
    onOpenAnyway: () => {},
  },
};

/** The start failed: wings folded, the reason on a chit, Show logs and Try again. */
export const Failed: Story = {
  args: {
    line: {
      tone: "error",
      text: t("web.splash.failed"),
      reason: "launchctl could not load com.psyche.gateway",
    },
    onShowLogs: () => {},
    onRetry: () => {},
    onOpenAnyway: () => {},
  },
};
