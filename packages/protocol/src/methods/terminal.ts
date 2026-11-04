import { type Static, Type } from "@sinclair/typebox";
import { Nullable } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `terminal.session.*`: a shell on the Host over the Gateway socket (remote-gateway design §4.2,
 * R4). The Gateway starts the PTY on the machine it runs on and streams its output to the one
 * device that opened it; keystrokes come back as `write` calls. Nothing runs on the client.
 *
 * It is a shell on the owner's main Mac, so opening one needs `operator.admin` and fresh presence
 * (or the desktop shell on the Host itself while no presence verifier is registered), and a
 * session belongs to the device that opened it: no other device can write to, resize, ack,
 * close or receive it. Sessions end when the device has been gone a short while or is revoked.
 *
 * Output is flow-controlled: each `terminal.output` event carries a running character count
 * (`end`), and the client confirms what it has rendered with `terminal.session.ack`. The Gateway
 * stops reading the PTY while more than the window is unconfirmed, so a client that stalls costs
 * the Host a bounded amount of memory. Terminal contents are never logged or audited; only the
 * open and the close are (kind `terminal.session.open` / `terminal.session.close`).
 */

/** Largest single `terminal.session.write`, in UTF-8 bytes. */
export const TERMINAL_WRITE_MAX_BYTES = 64 * 1024;
/** Characters of output the Gateway sends before it needs an `ack`. */
export const TERMINAL_OUTPUT_WINDOW = 256 * 1024;

const SessionId = Type.String({ minLength: 1, maxLength: 64 });

export const TerminalOutputPayload = Type.Object(
  {
    sessionId: SessionId,
    data: Type.String({ description: "Terminal output, UTF-8 decoded" }),
    end: Type.Integer({
      minimum: 0,
      description: "Characters sent in this session up to and including this chunk",
    }),
  },
  { $id: "TerminalOutputPayload" },
);
export type TerminalOutputPayload = Static<typeof TerminalOutputPayload>;

export const TerminalExitPayload = Type.Object(
  {
    sessionId: SessionId,
    exitCode: Nullable(Type.Integer()),
    reason: Type.Union(
      [
        Type.Literal("exited"),
        Type.Literal("closed"),
        Type.Literal("device_disconnected"),
        Type.Literal("device_revoked"),
        Type.Literal("gateway_stopped"),
      ],
      { description: "Why the session ended" },
    ),
  },
  { $id: "TerminalExitPayload" },
);
export type TerminalExitPayload = Static<typeof TerminalExitPayload>;

export const TerminalMethods = {
  "terminal.session.open": defineMethod({
    params: Type.Object({
      cols: Type.Integer({ minimum: 1, maximum: 500 }),
      rows: Type.Integer({ minimum: 1, maximum: 200 }),
      cwd: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4096,
          description: "An absolute folder on the Host",
        }),
      ),
      approvalId: Type.Optional(
        Type.String({ description: "The approved presence card from a first approval_required" }),
      ),
    }),
    result: Type.Object({
      sessionId: SessionId,
      target: Type.Literal("host"),
      label: Type.String({ description: "What the pane shows: the shell and folder" }),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Starts a shell on the Host and returns its session id; output arrives as terminal.output events on this device. Needs operator.admin and fresh presence (or the desktop shell on the Host before any verifier exists). Side-effecting.",
  }),
  "terminal.session.write": defineMethod({
    params: Type.Object({
      sessionId: SessionId,
      data: Type.String({ maxLength: TERMINAL_WRITE_MAX_BYTES }),
    }),
    result: Type.Object({}),
    scope: "operator.admin",
    description: "Sends keystrokes to a session this device opened (at most 64 KB a call).",
  }),
  "terminal.session.resize": defineMethod({
    params: Type.Object({
      sessionId: SessionId,
      cols: Type.Integer({ minimum: 1, maximum: 500 }),
      rows: Type.Integer({ minimum: 1, maximum: 200 }),
    }),
    result: Type.Object({}),
    scope: "operator.admin",
    description: "Resizes the PTY of a session this device opened.",
  }),
  "terminal.session.ack": defineMethod({
    params: Type.Object({
      sessionId: SessionId,
      end: Type.Integer({
        minimum: 0,
        description: "The `end` of the last terminal.output chunk the client has rendered",
      }),
    }),
    result: Type.Object({}),
    scope: "operator.admin",
    description:
      "Confirms output the client rendered; the Gateway reads the PTY again once less than the window is unconfirmed.",
  }),
  "terminal.session.close": defineMethod({
    params: Type.Object({ sessionId: SessionId }),
    result: Type.Object({ closed: Type.Boolean() }),
    scope: "operator.admin",
    description: "Ends a session this device opened (kills its shell). Idempotent.",
  }),
} as const;
