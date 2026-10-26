import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "../../lib/utils.ts";

function Progress({
  className,
  children,
  value,
  max = 100,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      value={value}
      max={max}
      data-slot="progress"
      className={cn("flex flex-wrap gap-3", className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator {...(typeof value === "number" ? { fraction: value / max } : {})} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-fill-secondary",
        className,
      )}
      data-slot="progress-track"
      {...props}
    />
  );
}

/**
 * The fill. Base UI sizes it with `width`; this lays it out once at full width and scales it with
 * `transform` (motion.md rule 7: no animated layout properties), from the inline start so it
 * mirrors in RTL. Without a `fraction` (indeterminate) Base UI's own sizing stays.
 */
function ProgressIndicator({
  className,
  fraction,
  style,
  ...props
}: ProgressPrimitive.Indicator.Props & { fraction?: number }) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        "h-full bg-primary transition-transform duration-(--spring-smooth-duration) ease-(--spring-smooth) origin-left rtl:origin-right",
        className,
      )}
      {...props}
      style={
        fraction === undefined
          ? style
          : {
              ...style,
              width: "100%",
              transform: `scaleX(${Math.min(1, Math.max(0, fraction))})`,
            }
      }
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-sm font-medium", className)}
      data-slot="progress-label"
      {...props}
    />
  );
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn("ml-auto text-sm text-muted-foreground tabular-nums", className)}
      data-slot="progress-value"
      {...props}
    />
  );
}

export { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue };
