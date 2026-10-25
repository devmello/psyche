import { cn } from "../../lib/utils.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("psy-shimmer rounded-md bg-fill-secondary", className)}
      {...props}
    />
  );
}

export { Skeleton };
