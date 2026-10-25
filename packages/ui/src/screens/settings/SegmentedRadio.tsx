import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A segmented control with radio semantics (docs/design/redesign-2026.md §5.8): one radio group,
 * Tab enters it once and the arrow keys move between segments. Each segment's accessible name
 * can carry its row ("search: Deny") so a list of them stays unambiguous.
 */
export function SegmentedRadio<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  segmentLabel,
  className,
}: {
  /** Names the group. */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** The accessible name of one segment; defaults to its visible label. */
  segmentLabel?: (option: { value: T; label: string }) => string;
  className?: string;
}): ReactElement {
  return (
    <RadioGroupPrimitive
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={(v) => onChange(v as T)}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md bg-fill-tertiary p-0.5 data-disabled:opacity-50",
        className,
      )}
    >
      {options.map((o) => (
        <RadioPrimitive.Root
          key={o.value}
          value={o.value}
          aria-label={segmentLabel ? segmentLabel(o) : o.label}
          className="h-6 min-w-12 cursor-default rounded-sm px-2.5 text-callout text-label-secondary outline-none transition-[background-color,color,box-shadow] duration-(--duration-micro) hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-surface-raised data-checked:text-label-primary data-checked:shadow-[0_0_0_0.5px_var(--separator),0_1px_2px_oklch(0_0_0/8%)]"
        >
          {o.label}
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}
