import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, StringEnum } from "../common.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import {
  ActionProposal,
  ActionProposalStatus,
  MeetingNotesResult,
  MeetingRecordingStatus,
  RecordingSpeakers,
} from "../schemas/workflows.ts";
import { SurfaceAnswerToken } from "./approvals.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/**
 * `proposals.*`: batch proposals (docs/workflows/mail-and-meetings-2026.md §8.1). Follow-ups
 * are the memory graph's loops (`memory.loops.*`).
 */
export const ProposalsMethods = {
  "proposals.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(ActionProposalStatus)),
      postId: Type.Optional(Id),
      ...pageParams,
    }),
    result: Type.Object({ proposals: Type.Array(ActionProposal), ...nextCursor }),
    scope: "operator.read",
    description: "Lists batch proposals (default: pending and awaiting approval), newest first.",
  }),
  "proposals.get": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: ActionProposal }),
    scope: "operator.read",
    description: "Returns one batch proposal with its calls and, once run, per-call results.",
  }),
  "proposals.approve": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({
      proposal: ActionProposal,
      /** The `batch` approval bound to the ordered calls; answer it with `approvals.answer`. */
      approval: ApprovalRequest,
      /** This device's single-use answer token for the approval (security §3.7). */
      answerToken: Type.Optional(SurfaceAnswerToken),
    }),
    scope: "operator.approvals",
    sideEffecting: true,
    description:
      "Requests the one batch approval for a proposal (kind batch, bound to the ordered list of calls, once only). The calls run after the approval is answered. Side-effecting.",
  }),
  "proposals.dismiss": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: ActionProposal }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Dismisses a pending proposal; its approval, if any, is invalidated. Side-effecting.",
  }),
  "proposals.undo": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: ActionProposal }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Offers the inverse proposal of a finished one (reversible mail actions only, within 30 s); it needs its own approval. Side-effecting.",
  }),
} as const;

/**
 * `meetings.*`: post-meeting notes (docs/workflows/mail-and-meetings-2026.md §4.6). Notes start
 * only from audio the owner chose: a Library item, or a recording the owner started with
 * "Record meeting" after confirming the consent line. Progress and the finished notes arrive as
 * `meetings.recording.updated` and the `meeting_notes` Feed post.
 */
export const MeetingsMethods = {
  "meetings.notes.create": defineMethod({
    params: Type.Object({
      /** A recording or audio file in the Library (dropped into chat or the Library). */
      libraryItemId: Id,
      /** When the recording started; default the item's creation time. */
      startedAt: Type.Optional(IsoDateTime),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      /** Default `others`: a meeting is other people's words, so the notes are untrusted. */
      speakers: Type.Optional(RecordingSpeakers),
    }),
    result: MeetingNotesResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Writes meeting notes from a Library recording: transcribed on the Mac (up to 4 h), matched to the overlapping calendar event, summarized into one meeting_notes Feed post. Proposes, never sends. Side-effecting.",
  }),
  "meetings.record.status": defineMethod({
    params: Type.Object({}),
    result: MeetingRecordingStatus,
    scope: "operator.read",
    description:
      "Whether Record meeting is available and running, the consent line to show before a start, and the last recording's notes.",
  }),
  "meetings.record.start": defineMethod({
    params: Type.Object({
      /** True only after the owner confirmed "I've told everyone"; anything else is refused. */
      consentConfirmed: Type.Boolean(),
      meetingId: Type.Optional(Type.String({ maxLength: 512 })),
    }),
    result: MeetingRecordingStatus,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Starts recording a meeting with the helper microphone, only after the owner confirmed the consent line. Stops by itself after 5 minutes of silence or when the conference app quits. Side-effecting.",
  }),
  "meetings.record.push": defineMethod({
    params: Type.Object({
      seq: Type.Integer({
        minimum: 0,
        description: "0, 1, 2… per recording; out of order is rejected",
      }),
      audio: Type.String({
        maxLength: 512_000,
        description: "Base64 mono PCM s16le at 16 kHz (the format `voice.push` takes)",
      }),
    }),
    result: Type.Object({}),
    scope: "operator.write",
    description:
      "Appends one chunk of the running recording's audio, captured by the device that started it (microphone in the desktop or web shell). Only that device may push. The Gateway stores it as a Library recording, and the recording ends by itself if chunks stop for two minutes or the device disconnects.",
  }),
  "meetings.record.stop": defineMethod({
    params: Type.Object({
      reason: Type.Optional(
        StringEnum(["stopped", "source_ended", "silence", "app_quit"], {
          description:
            "Why the capturing device stopped: the owner (default), the microphone ended, five minutes of silence, or the conference app quit",
        }),
      ),
    }),
    result: MeetingRecordingStatus,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Stops the running recording; its notes are written in the background (meetings.recording.updated, then the meeting_notes post). Side-effecting.",
  }),
} as const;
