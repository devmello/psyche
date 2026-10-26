import type { Meta, StoryObj } from "@storybook/react-vite";
import { t } from "../i18n/core.ts";
import { withWorld } from "../stories/harness.tsx";
import { StartupSplashView } from "./StartupSplashView.tsx";

/**
 * The startup splash (#595): the mark draws in, the lantern breathes, then it hands off. The
 * visual suite renders every story in light and dark.
 */
const meta = {
  title: "Shell/Startup splash",
  component: StartupSplashView,
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
  args: { line: { tone: "progress", text: t("web.splash.starting") } },
} satisfies Meta<typeof StartupSplashView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Starting: Story = {};

/** Reduced motion: no stroke draw, no breathing, no flight; one crossfade. */
export const ReducedMotion: Story = { globals: { motion: "reduced" } };

/** A slow start: after a few seconds the app is one click away. */
export const SlowStart: Story = {
  args: { line: { tone: "progress", text: t("web.splash.helper") }, onOpenAnyway: () => {} },
};

/** The start failed: the reason, Show logs and Retry. */
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
