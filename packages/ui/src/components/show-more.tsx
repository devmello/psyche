import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { Button } from "./ui/button.tsx";

/**
 * "Show 4 more" / "Show less" under a list that is cut short (Home's brief and suggestions). A
 * quiet button; it says how many are hidden and tells assistive tech whether the list is open.
 */
export function ShowMore({
  hidden,
  expanded,
  onToggle,
  controls,
}: {
  /** How many items the collapsed list leaves out. */
  hidden: number;
  expanded: boolean;
  onToggle: () => void;
  /** The id of the list this button opens, for `aria-controls`. */
  controls?: string;
}): ReactElement | null {
  if (hidden <= 0) return null;
  return (
    <div className="flex justify-center">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        {...(controls ? { "aria-controls": controls } : {})}
        onClick={onToggle}
      >
        {expanded ? t("home.showLess") : t("home.showMore", { n: hidden })}
      </Button>
    </div>
  );
}
