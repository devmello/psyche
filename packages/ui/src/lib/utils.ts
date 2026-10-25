import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's stock sizes, so it would read the kit's type roles
 * (`text-reading`, `text-title-1`, …; docs/design/redesign-2026.md §3.2) as colours and drop them next to `text-gray-11`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "large-title",
            "title-1",
            "title-2",
            "title-3",
            "headline",
            "body",
            "reading",
            "callout",
            "subheadline",
            "caption",
            "mono",
            "h2",
            "h3",
            "small",
          ],
        },
      ],
      shadow: [{ shadow: ["elevation-1", "elevation-2", "elevation-3", "level-2"] }],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (shadcn's `cn`). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
