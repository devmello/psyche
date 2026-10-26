import type { MeetingAttendee, MeetingPrep, SourcedLine } from "@psyche/protocol";
import { ChevronRight, Video } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { formatDuration, formatTime } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { initials } from "../../people/glyphs.tsx";
import { CardSection, TaintChip, WorkflowCardFrame } from "./shared.tsx";

export interface MeetingPrepCardProps {
  prep: MeetingPrep;
  now?: number;
  focused?: boolean;
  /** Opens a line's source: a thread, note, loop, Library item, URL or past meeting. */
  onSource?: (source: NonNullable<SourcedLine["source"]>) => void;
  onJoin?: (url: string) => void;
  onAttendee?: (attendee: MeetingAttendee) => void;
  className?: string;
}

function AttendeeChip({
  attendee,
  onOpen,
}: {
  attendee: MeetingAttendee;
  onOpen?: (a: MeetingAttendee) => void;
}): ReactElement {
  const name = attendee.name ?? attendee.email;
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full text-[10px] leading-none font-semibold",
          attendee.relationship === "external"
            ? "bg-accent-3 text-accent-11"
            : "bg-fill-secondary text-label-primary",
        )}
      >
        {initials(name)}
      </span>
      <span className="truncate">{name}</span>
    </>
  );
  const cls =
    "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-fill-tertiary ps-1 pe-2.5 text-callout text-label-primary";
  return (
    <li title={attendee.summary ?? attendee.email}>
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(attendee)}
          className={cn(
            cls,
            "cursor-default hover:bg-fill-secondary focus-visible:outline-2 focus-visible:outline-ring",
          )}
        >
          {body}
        </button>
      ) : (
        <span className={cls}>{body}</span>
      )}
    </li>
  );
}

function Line({
  line,
  onSource,
}: {
  line: SourcedLine;
  onSource?: MeetingPrepCardProps["onSource"];
}): ReactElement {
  const source = line.source;
  return (
    <li className="text-body text-label-primary">
      {line.text}
      {source && onSource ? (
        <>
          {" "}
          <button
            type="button"
            onClick={() => onSource(source)}
            className="cursor-default rounded-xs text-callout text-accent-11 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t("workflows.prep.source", { label: source.label ?? source.ref })}
          >
            {source.label ?? source.kind}
          </button>
        </>
      ) : null}
    </li>
  );
}

const LIST = "flex list-disc flex-col gap-1 ps-5 marker:text-label-tertiary";

/**
 * Meeting prep (docs/workflows/mail-and-meetings-2026.md §7.1, §4.5): the meeting's title and
 * time, attendees as avatar chips, then why, open loops, last time, worth reading and a suggested
 * agenda, each line with its source, and Join when the event has a link. Once the meeting has
 * started the card collapses to one line in the day's Feed.
 */
export function MeetingPrepCard({
  prep,
  now: fixedNow,
  focused = false,
  onSource,
  onJoin,
  onAttendee,
  className,
}: MeetingPrepCardProps): ReactElement {
  // Ticks, so the card collapses when the meeting starts.
  const now = useNow(30_000, fixedNow);
  const started = Date.parse(prep.startAt) <= now;
  const [expanded, setExpanded] = useState(false);
  const time = formatTime(prep.startAt);
  const join = prep.joinUrl;

  if (started && !expanded) {
    return (
      <article
        data-kind="meeting_prep"
        data-collapsed="true"
        aria-label={prep.title}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-lg bg-surface-raised px-4 py-2.5 shadow-elevation-1",
          className,
        )}
      >
        <p className="min-w-0 flex-1 truncate text-body text-label-secondary">
          {t("workflows.prep.started", { title: prep.title, time })}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          {t("workflows.prep.showPrep")}
          <ChevronRight aria-hidden="true" className="rtl:-scale-x-100" />
        </Button>
      </article>
    );
  }

  const until = Date.parse(prep.startAt) - now;
  const when = until > 0 ? t("time.in", { label: formatDuration(until) }) : time;
  const nothing =
    !prep.why &&
    prep.openLoops.length === 0 &&
    prep.lastTime.length === 0 &&
    prep.worthReading.length === 0 &&
    prep.agenda.length === 0;

  return (
    <WorkflowCardFrame
      data-kind="meeting_prep"
      kind={`${t("workflows.kind.meetingPrep")} · ${t("workflows.prep.when", { time, when })}`}
      title={prep.title}
      chips={prep.taint ? <TaintChip /> : null}
      trailing={
        join && onJoin ? (
          <Button
            type="button"
            size="sm"
            variant={focused ? "default" : "secondary"}
            onClick={() => onJoin(join)}
          >
            <Video aria-hidden="true" />
            {t("workflows.prep.join")}
          </Button>
        ) : null
      }
      {...(className ? { className } : {})}
    >
      {prep.attendees.length > 0 ? (
        <ul aria-label={t("workflows.prep.attendees")} className="flex flex-wrap gap-1.5">
          {prep.attendees.map((a) => (
            <AttendeeChip
              key={a.email}
              attendee={a}
              {...(onAttendee ? { onOpen: onAttendee } : {})}
            />
          ))}
        </ul>
      ) : null}
      {nothing ? (
        <p className="text-body text-label-secondary">{t("workflows.prep.nothingNew")}</p>
      ) : null}
      {prep.why ? (
        <CardSection title={t("workflows.prep.why")}>
          <ul className="flex flex-col">
            <Line line={prep.why} {...(onSource ? { onSource } : {})} />
          </ul>
        </CardSection>
      ) : null}
      {prep.openLoops.length > 0 ? (
        <CardSection title={t("workflows.prep.openLoops")}>
          <ul className={LIST}>
            {prep.openLoops.map((l) => (
              <li key={l.id} className="text-body text-label-primary">
                {l.direction === "i_owe"
                  ? t("workflows.prep.youOwe", { text: l.text })
                  : t("workflows.prep.theyOwe", { text: l.text })}
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}
      {prep.lastTime.length > 0 ? (
        <CardSection title={t("workflows.prep.lastTime")}>
          <ul className={LIST}>
            {prep.lastTime.map((line) => (
              <Line key={line.text} line={line} {...(onSource ? { onSource } : {})} />
            ))}
          </ul>
        </CardSection>
      ) : null}
      {prep.worthReading.length > 0 ? (
        <CardSection title={t("workflows.prep.worthReading")}>
          <ul className={LIST}>
            {prep.worthReading.map((line) => (
              <Line key={line.text} line={line} {...(onSource ? { onSource } : {})} />
            ))}
          </ul>
        </CardSection>
      ) : null}
      {prep.agenda.length > 0 ? (
        <CardSection title={t("workflows.prep.agenda")}>
          <ol className="flex list-decimal flex-col gap-1 ps-5 marker:text-label-tertiary">
            {prep.agenda.map((a) => (
              <li key={a} className="text-body text-label-primary">
                {a}
              </li>
            ))}
          </ol>
        </CardSection>
      ) : null}
    </WorkflowCardFrame>
  );
}
