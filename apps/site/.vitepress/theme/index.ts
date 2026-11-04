import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Landing from "./landing/Landing.vue";
import "./style.css";

/** The default theme in the app's "ink" world, plus the landing page (`layout: landing`). */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("landing", Landing);
  },
} satisfies Theme;
