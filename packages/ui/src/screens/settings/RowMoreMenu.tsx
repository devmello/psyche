import { Ellipsis } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";

/** A row action that loses something: shown in red under ⋯, and only after a confirm dialog. */
export interface DestructiveRowAction {
  /** Menu item, e.g. "Remove". */
  label: string;
  /** Dialog title, e.g. "Remove Gmail?". */
  title: string;
  /** What is lost and what is kept, one or two sentences. */
  description: ReactNode;
  /** The confirm button, e.g. "Remove". */
  confirm: string;
  onConfirm: () => void;
}

/**
 * The ⋯ menu at the end of a row (docs/ui-audit.md decision 7): plain secondary actions, then
 * destructive ones, which always ask first. The row's one primary or outline action stays
 * outside the menu.
 */
export function RowMoreMenu({
  name,
  items = [],
  destructive = [],
}: {
  /** The row's name, for the trigger's label ("More for Gmail"). */
  name: string;
  items?: readonly { label: string; onClick: () => void }[];
  destructive?: readonly DestructiveRowAction[];
}): ReactElement | null {
  const [asking, setAsking] = useState<DestructiveRowAction | null>(null);
  if (items.length === 0 && destructive.length === 0) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${name}`} />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {items.map((i) => (
            <DropdownMenuItem key={i.label} onClick={i.onClick}>
              {i.label}
            </DropdownMenuItem>
          ))}
          {items.length > 0 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
          {destructive.map((d) => (
            <DropdownMenuItem key={d.label} variant="destructive" onClick={() => setAsking(d)}>
              {d.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking?.title}</AlertDialogTitle>
            <AlertDialogDescription>{asking?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const a = asking;
                setAsking(null);
                a?.onConfirm();
              }}
            >
              {asking?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
