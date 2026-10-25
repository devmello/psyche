import type { ReactElement, ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet.tsx";
import { t } from "../i18n/core.ts";

/**
 * The compact threads drawer (redesign §5.11): the Threads group in a sheet from the start edge,
 * opened by the top bar's leading button or ⌘B.
 */
export function ThreadsDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}): ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[min(320px,85vw)] gap-0 p-0"
        showCloseButton={false}
        data-testid="threads-drawer"
      >
        <SheetTitle className="sr-only">{t("shell.threads.region")}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
