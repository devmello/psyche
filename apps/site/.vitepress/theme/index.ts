import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Landing from "./landing/Landing.vue";
// The notebook serif off Apple systems (New York ships with macOS and iOS, so it is never fetched there).
import "@fontsource-variable/source-serif-4/opsz.css";
import "./style.css";

/** The default theme in the app's "ink" world, plus the landing page (`layout: landing`). */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("landing", Landing);
  },
} satisfies Theme;
