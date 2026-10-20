import type { ReactElement, ReactNode } from "react";
import { useSettings } from "../data/hooks.ts";
import { appearanceFromSettings, ThemeProvider } from "../theme/ThemeProvider.tsx";

/**
 * The owner's Appearance settings (theme, accent, gray, density, contrast, reduce motion)
 * applied to the window: `ThemeProvider` fed from `settings.get` and `settings.changed`. Without
 * it the theme CSS, dark mode, high contrast and `data-reduce-motion` are never set (docs/a11y-audit.md A2).
 */
export function AppearanceProvider({ children }: { children?: ReactNode }): ReactElement {
  const { settings } = useSettings();
  return <ThemeProvider settings={appearanceFromSettings(settings)}>{children}</ThemeProvider>;
}
