import type { PsycheBridge } from "../preload.ts";

declare global {
  interface Window {
    /** Exposed by src/preload.ts through contextBridge. */
    psyche: PsycheBridge;
  }
}

export type { PsycheBridge };
