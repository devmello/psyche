import type { LibraryItem, Provenance } from "@psyche/protocol";

/** What the Gateway's Library needs to store a recording (a voice memo). */
export interface LibrarySaveInput {
  data: Uint8Array;
  name: string;
  mime: string;
  threadId: string | null;
  tags: string[];
  /** Default `audio`; voice memos are `recording`. */
  kind?: "audio" | "recording";
  /** Default `agent`; a composer memo is `upload`, a channel voice note `channel`. */
  origin?: LibraryItem["origin"];
  /** Who produced the content; `untrusted` recordings follow the quarantine rules (data model §9). */
  provenance?: Provenance;
  /** Plain text of the audio (a transcript), stored as the item's text extract. */
  textExtract?: string;
}

export interface LibraryWriter {
  saveAudio(file: LibrarySaveInput): Promise<LibraryItem>;
}
