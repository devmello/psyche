import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  // Native feel (docs/design/redesign-2026.md §3.8, motion.md §4.8): no pointer cursor, no
  // press movement; fills change over 100 ms on hover and instantly on press.
  "group/button inline-flex shrink-0 cursor-default items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity] duration-(--duration-micro) ease-(--ease-standard) outline-none select-none active:duration-(--duration-instant) focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        /** The one accent-filled action per view (§3.3). */
        default:
          "bg-primary text-primary-foreground hover:bg-accent-10 active:bg-accent-10 dark:hover:shadow-[inset_0_0_0_1px_var(--accent-11)]",
        prominent:
          "bg-primary text-primary-foreground hover:bg-accent-10 active:bg-accent-10 dark:hover:shadow-[inset_0_0_0_1px_var(--accent-11)]",
        /** A bordered macOS push button on a raised surface. */
        outline:
          "border-separator-strong bg-surface-raised text-label-primary shadow-[0_1px_1px_oklch(0_0_0/4%)] hover:bg-fill-quaternary active:bg-fill-secondary aria-expanded:bg-fill-secondary dark:bg-fill-tertiary dark:hover:bg-fill-secondary",
        secondary:
          "bg-fill-secondary text-label-primary hover:bg-fill-primary active:bg-fill-primary aria-expanded:bg-fill-primary",
        ghost:
          "text-label-primary hover:bg-fill-tertiary active:bg-fill-secondary aria-expanded:bg-fill-secondary",
        /** Borderless text action in the accent (Apple's plain button). */
        plain: "text-accent-11 hover:bg-fill-tertiary active:bg-fill-secondary",
        destructive:
          "bg-danger-surface text-tomato-12 hover:bg-tomato-4 active:bg-tomato-4 focus-visible:border-tomato-9 focus-visible:ring-tomato-9 dark:text-danger-text",
        link: "cursor-pointer text-accent-11 underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs in-data-[slot=button-group]:rounded-sm has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-sm px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-sm has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        /** Large controls are capsules, as in macOS 26 (§3.5). */
        lg: "h-9 gap-2 rounded-full px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-sm in-data-[slot=button-group]:rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-sm in-data-[slot=button-group]:rounded-sm",
        "icon-lg": "size-9 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
