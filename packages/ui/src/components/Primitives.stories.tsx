import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bell, Inbox, Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, ErrorState, GroupedList, GroupedRow, LoadingCards } from "./page.tsx";
import { StatusGlyph } from "./status.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input } from "./ui/input.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { Label } from "./ui/label.tsx";
import { NativeSelect } from "./ui/native-select.tsx";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover.tsx";
import { Progress } from "./ui/progress.tsx";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.tsx";
import { Separator } from "./ui/separator.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Switch } from "./ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * Every components/ui primitive on the redesign roles (docs/design/redesign-2026.md §6), in
 * light and dark (visual baseline), high contrast and reduced motion.
 */
const meta = {
  title: "Primitives/Kit",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-caption text-label-secondary">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

function Controls() {
  return (
    <div className="flex max-w-3xl flex-col gap-6 bg-canvas p-2">
      <Row title="Buttons">
        <Button>Allow</Button>
        <Button variant="outline">Deny</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="plain">Plain</Button>
        <Button variant="destructive">Remove</Button>
        <Button variant="link">Link</Button>
        <Button disabled>Disabled</Button>
      </Row>
      <Row title="Sizes">
        <Button size="xs" variant="outline">
          Extra small
        </Button>
        <Button size="sm" variant="outline">
          Small
        </Button>
        <Button variant="outline">Regular</Button>
        <Button size="lg">Large capsule</Button>
        <Button size="icon-sm" variant="ghost" aria-label="Add">
          <Plus aria-hidden="true" />
        </Button>
        <Button size="icon" variant="outline" aria-label="Notifications">
          <Bell aria-hidden="true" />
        </Button>
      </Row>
      <Row title="Fields">
        <div className="flex w-64 flex-col gap-1.5">
          <Label htmlFor="p-name">Name</Label>
          <Input id="p-name" defaultValue="Wren" />
        </div>
        <div className="flex w-64 flex-col gap-1.5">
          <Label htmlFor="p-model">Model</Label>
          <NativeSelect id="p-model" defaultValue="sonnet">
            <option value="sonnet">Sonnet 5.5</option>
            <option value="opus">Opus 5.5</option>
          </NativeSelect>
        </div>
        <div className="flex w-full flex-col gap-1.5">
          <Label htmlFor="p-notes">Notes</Label>
          <Textarea id="p-notes" placeholder="What should Wren remember?" />
        </div>
      </Row>
      <Row title="Choices">
        <div className="flex items-center gap-2">
          <Switch id="p-switch" defaultChecked aria-label="Memory on" />
          <Label htmlFor="p-switch">Memory</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="p-check" defaultChecked />
          <Label htmlFor="p-check">Make recurring</Label>
        </div>
        <RadioGroup defaultValue="balanced" aria-label="Permission mode" className="flex gap-4">
          <div className="flex items-center gap-2">
            <RadioGroupItem value="balanced" id="p-balanced" />
            <Label htmlFor="p-balanced">Balanced</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="manual" id="p-manual" />
            <Label htmlFor="p-manual">Manual</Label>
          </div>
        </RadioGroup>
        <ToggleGroup defaultValue={["ask"]} aria-label="Gmail send">
          <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
          <ToggleGroupItem value="ask">Ask</ToggleGroupItem>
          <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
        </ToggleGroup>
      </Row>
      <Row title="Segmented and line tabs">
        <Tabs defaultValue="activity">
          <TabsList>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="approvals">Approvals</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          </TabsList>
          <TabsContent value="activity" className="sr-only">
            Activity
          </TabsContent>
        </Tabs>
        <Tabs defaultValue="documents">
          <TabsList variant="line">
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="images">Images</TabsTrigger>
          </TabsList>
          <TabsContent value="documents" className="sr-only">
            Documents
          </TabsContent>
        </Tabs>
      </Row>
      <Row title="Status and chips">
        <StatusGlyph status="running" label="Running" />
        <StatusGlyph status="done" label="Done" />
        <StatusGlyph status="failed" label="Failed" />
        <StatusGlyph status="waiting" label="Waiting for you" />
        <StatusGlyph status="paused" label="Paused" />
        <Badge>New</Badge>
        <Badge variant="approval">Needs you</Badge>
        <Badge variant="success">Sent</Badge>
        <Badge variant="danger">Failed</Badge>
        <Badge variant="info">Briefing</Badge>
        <Badge variant="muted">Draft</Badge>
        <Kbd>⌘K</Kbd>
      </Row>
      <Row title="Progress and loading">
        <div className="w-64">
          <Progress value={60} aria-label="Milestones" />
        </div>
        <div className="flex w-64 flex-col gap-2" role="status" aria-label="Loading">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-full" />
        </div>
      </Row>
    </div>
  );
}

function Surfaces() {
  return (
    <div className="flex max-w-3xl flex-col gap-6 bg-canvas p-2">
      <Card>
        <CardHeader>
          <CardTitle>Headphones dropped to $189</CardTitle>
          <CardDescription>Watch result · shop.example</CardDescription>
        </CardHeader>
        <CardContent className="text-reading">
          The Sonora H2 is $189 at shop.example, down from $219.
        </CardContent>
      </Card>
      <GroupedList
        title="Default mode for new threads"
        footer="Writes to people and money always ask first."
      >
        <GroupedRow
          label="Balanced"
          description="Reads run; writes ask first"
          control={<Badge variant="muted">Default</Badge>}
        />
        <GroupedRow
          label="Notifications"
          leading={<Inbox className="size-4" aria-hidden="true" />}
          control={<Switch defaultChecked aria-label="Notifications" />}
        />
        <GroupedRow
          label="Advanced"
          leading={<Settings className="size-4" aria-hidden="true" />}
          control={
            <Button size="sm" variant="outline">
              Open…
            </Button>
          }
        />
      </GroupedList>
      <Separator />
      <div className="relative h-40 overflow-hidden rounded-lg bg-[linear-gradient(135deg,var(--accent-6),var(--gray-4),var(--amber-6))]">
        <div className="material-glass absolute inset-x-6 bottom-6 rounded-xl p-3 text-reading text-label-primary">
          Chrome glass over content (composer, popovers, palette)
        </div>
      </div>
      <EmptyState icon={Inbox} action={{ label: "Add a goal", onClick: () => {} }}>
        Tell Wren a goal in chat, or add one here.
      </EmptyState>
      <ErrorState
        what="Psyche couldn't load the feed"
        reason="the Gateway didn't answer"
        did="Your posts are safe on the Gateway."
        retry={{ onClick: () => {} }}
      />
      <LoadingCards label="Loading the feed" count={2} lines={2} />
    </div>
  );
}

export const ControlsOverview: Story = { render: () => <Controls /> };
export const SurfacesOverview: Story = { render: () => <Surfaces /> };
export const ControlsHighContrast: Story = {
  render: () => <Controls />,
  globals: { contrast: "high" },
};
export const SurfacesHighContrast: Story = {
  render: () => <Surfaces />,
  globals: { contrast: "high" },
};
export const ControlsReducedMotion: Story = {
  render: () => <Controls />,
  globals: { motion: "reduced" },
};

export const MenuOpen: Story = {
  render: () => (
    <div className="h-72">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger render={<Button variant="outline" />}>Thread</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem>
            Rename <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            Continue in a side chat <DropdownMenuShortcut>⌘;</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

export const PopoverOpen: Story = {
  render: () => (
    <div className="h-64">
      <Popover defaultOpen modal={false}>
        <PopoverTrigger render={<Button variant="outline" />}>Filter</PopoverTrigger>
        <PopoverContent align="start">
          <PopoverTitle>Filter the library</PopoverTitle>
          <PopoverDescription>Type, source task and date.</PopoverDescription>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

export const TooltipOpen: Story = {
  render: () => (
    <div className="flex h-32 items-end">
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon" aria-label="New side chat" />}
          >
            <Plus aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>
            New side chat <Kbd>⌘N</Kbd>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ),
};

export const DialogOpen: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="h-[480px]">
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Wren?</DialogTitle>
            <DialogDescription>
              This removes the persona files and memory. Threads stay.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline">Cancel</Button>
            <Button variant="destructive">Reset</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  ),
};

export const SheetOpen: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="h-[480px]">
      <Sheet defaultOpen>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Wren</SheetTitle>
            <SheetDescription>Holding the 2:30 slot</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    </div>
  ),
};
