import {
  BookOpen,
  Brain,
  CalendarClock,
  CircleHelp,
  Coins,
  Command,
  Cpu,
  Eraser,
  EyeOff,
  Folder,
  Globe,
  Inbox,
  Keyboard,
  Layers,
  ListChecks,
  type LucideIcon,
  MessageSquarePlus,
  Mic,
  Moon,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Target,
} from "lucide-react";
import { RAIL_ITEMS } from "./Rail.tsx";

/** One glyph per command, so a row says what it does before it is read (HIG: icons carry meaning). */
const BY_ID: Record<string, LucideIcon> = {
  new: MessageSquarePlus,
  incognito: EyeOff,
  browser: Globe,
  terminal: SquareTerminal,
  tasks: ListChecks,
  files: Folder,
  model: Cpu,
  mode: ShieldCheck,
  settings: Settings,
  shortcuts: Keyboard,
  "record-meeting": Mic,
  scheduled: CalendarClock,
  "scheduled-runs": CalendarClock,
  "new-automation": CalendarClock,
  inbox: Inbox,
  goals: Target,
  "add-goal": Target,
  overview: Sparkles,
  search: Search,
  approvals: ShieldCheck,
  soul: Sparkles,
  "memory-review": Brain,
  "memory-add-todo": Plus,
  "memory-add-project": Plus,
  "feed-instructions": SlidersHorizontal,
  "night-shift-review": Moon,
  "can-do": CircleHelp,
  "rerun-setup": RotateCcw,
  "add-mcp": Plus,
  "clear-main-chat": Eraser,
  "points-start": Coins,
  spaces: Layers,
  "spaces-new": Plus,
};

const BY_PREFIX: readonly (readonly [string, LucideIcon])[] = [
  ["memory-", Brain],
  ["library-", BookOpen],
  ["settings-", SlidersHorizontal],
  ["space-", Layers],
];

/** The icon of a palette action: its own kind's glyph; the four places use the sidebar's. */
export function paletteIcon(id: string): LucideIcon {
  if (id.startsWith("go-")) {
    return RAIL_ITEMS.find((i) => `go-${i.id}` === id)?.icon ?? Command;
  }
  return BY_ID[id] ?? BY_PREFIX.find(([p]) => id.startsWith(p))?.[1] ?? Command;
}
