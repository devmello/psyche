import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../components/ui/sheet.tsx";
import { Toaster } from "../components/ui/sonner.tsx";
import { LayoutMotion } from "./MotionProvider.tsx";
import { ListItem, Presence } from "./primitives.tsx";

/**
 * The desktop motion moments in one place (docs/design/motion.md §4). Toggle the Motion toolbar
 * item to "reduced" to see each one swap movement for an opacity fade. Used for the before and
 * after recordings; it has no visual baseline because it animates on purpose.
 */
// Dev-only story: its strings are demo labels, not product copy, so they are exempt from i18n.
function Showcase() {
  const [rows, setRows] = useState([1, 2, 3]);
  const [next, setNext] = useState(4);
  const toasts = useRef(0);
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => toast.success(`Saved to Library (${++toasts.current})`)}
        >
          Toast
        </Button>
        <Dialog>
          <DialogTrigger render={<Button variant="outline">Dialog</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dialog</DialogTitle>
              <DialogDescription>Fades in with a 0.98 scale. Alerts never slide.</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger render={<Button variant="outline">Sheet</Button>} />
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Sheet</SheetTitle>
              <SheetDescription>Slides in from its edge on spring.gentle.</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
        <Popover>
          <PopoverTrigger render={<Button variant="outline">Popover</Button>} />
          <PopoverContent>Scales from 0.97 at the anchor, then fades out in 105 ms.</PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline">Menu</Button>} />
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => {
            setRows((r) => [next, ...r]);
            setNext((v) => v + 1);
          }}
        >
          Insert row
        </Button>
        <Button variant="outline" onClick={() => setRows((r) => r.slice(1))}>
          Remove row
        </Button>
      </div>
      <LayoutMotion>
        <ul className="flex max-w-sm flex-col gap-1">
          <Presence mode="popLayout" initial={false}>
            {rows.map((row, i) => (
              <ListItem
                key={row}
                index={i}
                layout
                className="rounded-md bg-surface-raised px-3 py-2 text-body shadow-elevation-1"
              >
                Row {row}
              </ListItem>
            ))}
          </Presence>
        </ul>
      </LayoutMotion>
      <Toaster />
    </div>
  );
}

const meta = {
  title: "Motion/Showcase",
  component: Showcase,
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Showcase>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Moments: Story = {};
