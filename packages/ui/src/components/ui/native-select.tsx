import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A native `<select>` drawn like the kit's inputs (radius 8, gray-7 border, chevron). Use it where
 * a plain select is right (short option lists, forms) so no screen shows the browser's default
 * control; reach for `Select` when options need icons or descriptions.
 */
function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <span data-slot="native-select-wrapper" className="relative inline-flex w-fit min-w-0">
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "w-full min-w-0 appearance-none rounded-md border border-input bg-surface-raised shadow-[inset_0_0.5px_1px_oklch(0_0_0/4%)] dark:bg-fill-quaternary pr-8 pl-2.5 text-sm text-foreground transition-colors outline-none hover:border-gray-8 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:text-xs",
          className,
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-gray-11"
      />
    </span>
  );
}

export { NativeSelect };
