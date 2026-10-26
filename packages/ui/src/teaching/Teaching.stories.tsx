import type { Lesson, Message } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import { MessageView } from "../chat/MessageView.tsx";
import { createFixtureWorld, IDS, LEARNING_IDS } from "../fixtures/index.ts";
import { withWorld } from "../stories/harness.tsx";
import { TeachForm } from "./FeedbackActions.tsx";
import { LessonDetails, LessonMark } from "./LessonMark.tsx";
import { LearnedLine, TaughtLine } from "./TaughtLine.tsx";

/** The teaching loop in the chat column and its marks (docs/agent/teaching-loop-2026.md §5.1–5.2). */
const meta = {
  title: "Teaching/Feedback",
  decorators: [withWorld()],
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const L = LEARNING_IDS.lessons;
const world = createFixtureWorld();
const lesson = (id: string): Lesson => {
  const found = world.lessons.find((l) => l.id === id);
  if (found === undefined) throw new Error(`fixture lesson ${id} missing`);
  return found;
};
const answer = (fields: Partial<Message> = {}): Message => {
  const m = world.messages.find((x) => x.id === IDS.messages.mainAgent);
  if (m === undefined) throw new Error("fixture message missing");
  return { ...m, ...fields };
};

function Column({ children, narrow = false }: { children: ReactElement; narrow?: boolean }) {
  return <div className={narrow ? "max-w-[320px]" : "max-w-[640px]"}>{children}</div>;
}

/** An answer with Helpful / Not like this (shown on hover; always on touch). */
export const OnAMessage: Story = {
  render: () => (
    <Column>
      <MessageView message={answer()} />
    </Column>
  ),
};

/** The popover under Not like this, with "For Jane" offered. */
export const Popover: Story = {
  render: () => (
    <div className="w-80 rounded-lg bg-surface-raised p-2.5 shadow-elevation-1">
      <TeachForm person="Jane" onTeach={async () => {}} onCancel={() => {}} />
    </div>
  ),
};

/** After Teach: "Psyche will remember: …" with Undo and Change; and the no-lesson thanks. */
export const Taught: Story = {
  render: () => (
    <Column>
      <div className="flex flex-col gap-3">
        <TaughtLine
          feedbackId={LEARNING_IDS.feedback.janeTone}
          lessonId={L.janeShort}
          statement="Replies to Jane are short and start with the answer."
        />
        <TaughtLine feedbackId={LEARNING_IDS.feedback.helpful} lessonId={null} statement={null} />
      </div>
    </Column>
  ),
};

/** The `learned` block (#509) with Undo. */
export const Learned: Story = {
  render: () => (
    <Column>
      <LearnedLine
        items={[
          {
            factId: "lf_maya001",
            text: "Has a sister named Maya.",
            kind: "person",
            date: "2026-10-25",
            threadId: IDS.threads.main,
          },
          {
            factId: "lf_oat0001",
            text: "Takes oat milk.",
            kind: "preference",
            date: "2026-10-25",
            threadId: IDS.threads.main,
          },
        ]}
      />
    </Column>
  ),
};

/** "Used 2 lessons" in an answer's footer. */
export const UsedLessons: Story = {
  render: () => (
    <Column>
      <MessageView
        message={answer({
          lessonsApplied: [
            { lessonId: L.answerFirst, statement: lesson(L.answerFirst).statement, kind: "style" },
            { lessonId: L.janeShort, statement: lesson(L.janeShort).statement, kind: "style" },
          ],
        })}
      />
    </Column>
  ),
};

/** Marks for every destination: a file line, a refined one, a skill, an automation. */
export const Marks: Story = {
  render: () => (
    <ul className="flex max-w-[420px] flex-col gap-3">
      {[L.janeShort, L.answerFirst, L.mailFirst].map((id) => (
        <li key={id} className="flex flex-col gap-0.5">
          <span className="text-body">{lesson(id).statement}</span>
          <LessonMark lesson={lesson(id)} />
        </li>
      ))}
      <li className="flex flex-col gap-0.5">
        <span className="text-body">Morning brief</span>
        <LessonMark lesson={lesson(L.briefTime)} variant="automation" />
      </li>
    </ul>
  ),
};

/** The mark's popover content: statement, sources, the change, Keep / Edit / Forget. */
export const Details: Story = {
  render: () => (
    <div className="w-80 rounded-lg bg-surface-raised p-2.5 shadow-elevation-1">
      <LessonDetails lessonId={L.answerFirst} />
    </div>
  ),
};

/** Still loading the lesson. */
export const DetailsLoading: Story = {
  decorators: [withWorld({ options: { latency: 60_000 } })],
  render: Details.render,
};

/** The lesson could not be loaded. */
export const DetailsError: Story = {
  decorators: [
    withWorld({ onGateway: (g) => g.failNext("memory.lessons.get", "unavailable", "offline") }),
  ],
  render: Details.render,
};

/** A forgotten lesson: no actions left. */
export const DetailsEmpty: Story = {
  render: () => (
    <div className="w-80 rounded-lg bg-surface-raised p-2.5 shadow-elevation-1">
      <LessonDetails lessonId={L.forgotten} />
    </div>
  ),
};

export const Dark: Story = {
  ...Taught,
  globals: { theme: "dark" },
};

export const DarkMarks: Story = {
  ...Marks,
  globals: { theme: "dark" },
};

/** Narrow column: chips wrap, the line stays one sentence. */
export const Compact: Story = {
  render: () => (
    <Column narrow>
      <div className="flex flex-col gap-3">
        <TeachForm person="Jane" onTeach={async () => {}} onCancel={() => {}} />
        <TaughtLine
          feedbackId={LEARNING_IDS.feedback.janeTone}
          lessonId={L.janeShort}
          statement="Replies to Jane are short and start with the answer."
        />
      </div>
    </Column>
  ),
};
