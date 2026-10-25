import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

/**
 * A macOS segmented control (docs/design/redesign-2026.md §6): a fill-secondary track with a
 * raised indicator that moves to the active tab on `spring.micro` (motion.md §4.4). The indicator
 * is Base UI's, positioned from its CSS variables, so the move is a CSS transition and needs no
 * layout-animation bundle; under reduced motion it jumps.
 */
const tabsListVariants = cva(
  "group/tabs-list relative isolate inline-flex w-fit items-center justify-center text-label-secondary group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "rounded-md bg-fill-secondary p-0.5",
        line: "gap-1 rounded-none bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        className={cn(
          "pointer-events-none absolute top-0 left-0 -z-10 translate-x-(--active-tab-left) translate-y-(--active-tab-top) transition-[translate,width,height] duration-(--spring-micro-duration) ease-(--spring-micro)",
          variant === "line"
            ? "h-0.5 w-(--active-tab-width) translate-y-[calc(var(--active-tab-top)+var(--active-tab-height)+3px)] bg-label-primary"
            : "h-(--active-tab-height) w-(--active-tab-width) rounded-[6px] bg-surface-raised shadow-elevation-1 dark:bg-fill-primary",
        )}
      />
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 cursor-default items-center justify-center gap-1.5 rounded-[6px] border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap text-label-secondary transition-colors duration-(--duration-micro) group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-label-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:text-label-primary [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "flex-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
