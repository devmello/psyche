import type {
  Channel,
  ChannelType,
  EventName,
  EventPayload,
  InboundMessage,
  Provenance,
} from "@psyche/protocol";
import type { ParsedCommand } from "./commands.ts";
import type { RouteContext } from "./routing.ts";

/**
 * Local ports (not protocol contracts yet). The Gateway (S01) implements them when it mounts the
 * channel service; tests use the in-memory versions in `test/helpers.ts`.
 */

/** One piece of an inbound turn with its own provenance (review design-22). */
export interface InboundPart {
  text: string;
  provenance: Provenance;
  /** `forwarded` / `quoted`: someone else's words; `voice`: transcript of a voice note. */
  label?: "forwarded" | "quoted" | "voice" | "attachment";
}

export interface ChannelInboundEvent {
  /**
   * `message`: a turn for the session. `edit`: an edit of an earlier message — show it to the
   * owner, never apply it as a steer (design-22). `command`: a slash command the Gateway handles
   * (`/new`, `/stop`, `/status`, skills).
   */
  kind: "message" | "edit" | "command";
  route: RouteContext;
  message: InboundMessage;
  parts: InboundPart[];
  attachments: { libraryItemId: string }[];
  command?: ParsedCommand;
}

/** Where routed inbound traffic goes (the Gateway's session controller / agent-core). */
export interface InboundSink {
  deliver(event: ChannelInboundEvent): Promise<void>;
}

export interface LibraryIngestInput {
  name: string;
  mime: string;
  data: Uint8Array;
  provenance: Provenance;
  source: { channel: ChannelType; channelId: string; chatId: string; messageId: string };
}

/** Library quarantine (data model §9). Channel attachments are always ingested, never executed. */
export interface LibraryIngest {
  ingest(input: LibraryIngestInput): Promise<{ libraryItemId: string }>;
}

/** Gateway event fan-out (`channels.updated`, `pairing.requested`). */
export type EmitEvent = <E extends EventName>(event: E, payload: EventPayload<E>) => void;

/** Minimal structured logger; never pass message text, tokens or codes. */
export interface ChannelLogger {
  warn(event: string, data?: Record<string, unknown>): void;
  info?(event: string, data?: Record<string, unknown>): void;
}

export type ChannelStatus = Channel["status"];
