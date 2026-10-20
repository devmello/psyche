import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's stock sizes, so it would read the kit's type roles
 * (`text-label`, `text-h1`, …; UI design §4.2) as colours and drop them next to `text-gray-11`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["h1", "h2", "h3", "body", "small", "caption", "label", "mono"] }],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (shadcn's `cn`). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
