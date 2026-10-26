import type {
  FeedbackReason,
  FeedbackScope,
  FeedbackTarget,
  Lesson,
  LessonStatus,
  MethodParams,
  MethodResult,
} from "@psyche/protocol";
import { useMemo } from "react";
import { useGatewayQuery, useStore } from "../data/index.ts";
import { invalidateTeaching } from "../data/store.ts";

/**
 * The teaching loop's data (docs/agent/teaching-loop-2026.md §5, §7): lessons for the marks and
 * the owner's feedback. Queries reload on `feedback.recorded`, `lesson.changed` and
 * `growth.updated` (the store invalidates `memory.lessons.*`, `feedback.*` and `growth.*`).
 */

/** Lessons that still shape answers: what the marks show. */
export const LIVE_LESSONS: LessonStatus[] = ["proposed", "active", "confirmed"];

export function useLessons(params: MethodParams<"memory.lessons.list"> = {}) {
  const q = useGatewayQuery("memory.lessons.list", { status: LIVE_LESSONS, ...params });
  return { ...q, lessons: q.data?.lessons ?? [] };
}

/** One lesson with its sources, diff and history (the mark's popover). */
export function useLesson(lessonId: string | null) {
  return useGatewayQuery(
    "memory.lessons.get",
    { lessonId: lessonId ?? "" },
    {
      enabled: lessonId !== null,
    },
  );
}

export interface TeachInput {
  target: FeedbackTarget;
  kind: "helpful" | "not_helpful" | "correction";
  text?: string;
  reason?: FeedbackReason;
  scope?: FeedbackScope;
}

/** The owner's teaching actions; every one reloads the lesson queries when it settles. */
export function useTeaching() {
  const store = useStore();
  return useMemo(() => {
    const refresh = () => store.update(invalidateTeaching);
    return {
      give: async (input: TeachInput): Promise<MethodResult<"feedback.give">> => {
        const r = await store.call("feedback.give", input);
        refresh();
        return r;
      },
      /** Undo for feedback that made no lesson. */
      deleteFeedback: async (eventId: string) => {
        await store.call("feedback.delete", { eventId });
        refresh();
      },
      confirm: async (lessonId: string) => {
        const r = await store.call("memory.lessons.confirm", { lessonId });
        refresh();
        return r;
      },
      edit: async (lessonId: string, value: string) => {
        const r = await store.call("memory.lessons.edit", { lessonId, value });
        refresh();
        return r;
      },
      forget: async (lessonId: string) => {
        const r = await store.call("memory.lessons.forget", { lessonId });
        refresh();
        return r;
      },
    };
  }, [store]);
}

/** Lessons whose destination is `path` (a workspace file or a skill's `LESSONS.md`). */
export function lessonsAt(lessons: readonly Lesson[], path: string): Lesson[] {
  return lessons.filter(
    (l) =>
      (l.destination.type === "file" || l.destination.type === "skill") &&
      l.destination.path === path,
  );
}
