import type { Automation } from "@psyche/protocol";
import { Ellipsis } from "lucide-react";
import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useAutomations } from "../data/index.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "weekdays 07:00", "monthly on the 1st 09:00", "every 6 h" (UI design §3.16: the schedule as a sentence). */
export function scheduleSentence(a: Pick<Automation, "kind" | "schedule">): string {
  const iso = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?)$/.exec(a.schedule);
  if (iso) {
    const [, h, m] = iso;
    return `every ${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""}`;
  }
  const parts = a.schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, , dow] = parts as [string, string, string, string, string];
    const time =
      /^\d+$/.test(min) && /^\d+$/.test(hour)
        ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`
        : null;
    if (time !== null) {
      if (dow === "1-5" && dom === "*") return `weekdays ${time}`;
      if (dow === "*" && dom === "*") return `every day ${time}`;
      if (dom !== "*" && dow === "*") return `monthly on day ${dom} ${time}`;
      if (/^\d$/.test(dow)) return `${DAYS[Number(dow) % 7]}s ${time}`;
    }
    if (min.startsWith("*/")) return `every ${min.slice(2)} min`;
  }
  return a.schedule;
}

function target(a: Automation): string {
  if (a.sessionTarget.startsWith("named:")) return a.sessionTarget.slice(6);
  return a.sessionTarget;
}

export function UpcomingRow({
  automation: a,
  now,
  onRun,
  onToggle,
  onDelete,
  onEdit,
}: {
  automation: Automation;
  now: number;
  onRun?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
}): ReactElement {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.title}</span>
        <span className="block text-xs text-muted-foreground">
          {scheduleSentence(a)} · {target(a)}
          {a.nextRunAt ? ` · next ${formatRelative(a.nextRunAt, now)}` : ""}
          {a.lastStatus ? ` · last: ${a.lastStatus}` : ""}
        </span>
      </span>
      {a.kind === "watch" ? <Badge variant="outline">watch</Badge> : null}
      {!a.enabled ? <Badge variant="secondary">paused</Badge> : null}
      {onRun ? (
        <Button size="sm" variant="outline" onClick={onRun}>
          Run now
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label={`More for ${a.title}`} />}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onToggle ? (
            <DropdownMenuItem onClick={onToggle}>{a.enabled ? "Pause" : "Resume"}</DropdownMenuItem>
          ) : null}
          {onEdit ? <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem> : null}
          {onDelete ? (
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Agent sheet → Upcoming (UI design §3.16): reminders, scheduled tasks, watches, heartbeat. */
export function UpcomingPanel({
  now: fixedNow,
  onEdit,
}: {
  now?: number;
  onEdit?: (automation: Automation) => void;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const q = useAutomations();
  if (q.loading && q.automations.length === 0) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading upcoming">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (q.error && q.automations.length === 0) {
    return (
      <p className="text-sm">
        Psyche couldn't load your schedule ({q.error}).{" "}
        <button type="button" className="text-accent-11 underline" onClick={q.reload}>
          Try again
        </button>
      </p>
    );
  }
  if (q.automations.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nothing scheduled. Ask in chat with /schedule.
      </p>
    );
  }
  const sorted = [...q.automations].sort((a, b) =>
    (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999"),
  );
  return (
    <ul className="flex flex-col divide-y divide-gray-4" aria-label="Upcoming">
      {sorted.map((a) => (
        <UpcomingRow
          key={a.id}
          automation={a}
          now={now}
          onRun={() => void q.runNow(a.id)}
          onToggle={() => void q.setEnabled(a.id, !a.enabled)}
          onDelete={() => void q.remove(a.id)}
          {...(onEdit ? { onEdit: () => onEdit(a) } : {})}
        />
      ))}
    </ul>
  );
}
