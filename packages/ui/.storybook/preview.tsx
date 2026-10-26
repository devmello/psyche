import type { Preview } from "@storybook/react-vite";
import "../src/styles/index.css";
import { createI18n, setActiveI18n, setDefaultTimeZone } from "../src/i18n/core.ts";
import { ThemeProvider } from "../src/theme/ThemeProvider.tsx";

// Stable baselines: US English in UTC whatever the machine's region and clock (the app follows
// the owner's).
setDefaultTimeZone("UTC");
setActiveI18n(createI18n({ locale: "en-US" }));

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Appearance",
      toolbar: { title: "Theme", items: ["light", "dark"], dynamicTitle: true },
    },
    accent: {
      description: "Accent seed",
      toolbar: {
        title: "Accent",
        items: ["#6e56cf", "#0090ff", "#e54d2e", "#46a758", "#ffc53d"],
        dynamicTitle: true,
      },
    },
    motion: {
      description: "Reduced motion",
      toolbar: { title: "Motion", items: ["full", "reduced"], dynamicTitle: true },
    },
    contrast: {
      description: "Increase contrast",
      toolbar: { title: "Contrast", items: ["standard", "high"], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "light", accent: "#6e56cf", motion: "full", contrast: "standard" },
  parameters: {
    layout: "padded",
    a11y: { test: "error" },
  },
  decorators: [
    (Story, ctx) => (
      <ThemeProvider
        settings={{
          theme: ctx.globals.theme === "dark" ? "dark" : "light",
          accentSeed: String(ctx.globals.accent ?? "#6e56cf"),
          reduceMotion: ctx.globals.motion === "reduced",
          contrast: ctx.globals.contrast === "high" ? "high" : "standard",
        }}
      >
        <div className="bg-background text-foreground">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
};

export default preview;
