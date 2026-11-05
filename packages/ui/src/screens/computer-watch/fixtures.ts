import type { VscreenApp, VscreenFrame, VscreenInputEvent, VscreenStatus } from "@psyche/protocol";
import type { ComputerWatchClient } from "./ComputerWatch.tsx";

/** A 1x1 JPEG: stands in for a screen frame in stories and tests. */
export const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/** A second, different frame (the same pixel, a different encoding is not needed: the seq differs). */
export const TINY_JPEG_2 = `${TINY_JPEG.slice(0, -4)}AAA=`;

export const APPS: VscreenApp[] = [
  { appId: "org.gnome.TextEditor", pid: 101, windowTitle: "notes.txt", hasUnsavedChanges: true },
  { appId: "firefox", pid: 102, windowTitle: "Example Domain" },
];

export const RUNNING: VscreenStatus = {
  state: "running",
  display: ":90",
  width: 1280,
  height: 720,
  apps: APPS,
  takenOver: false,
  frameSeq: 1,
  startedAt: "2026-11-05T09:00:00.000Z",
};

export const STOPPED: VscreenStatus = {
  state: "stopped",
  display: null,
  width: 0,
  height: 0,
  apps: [],
  takenOver: false,
  frameSeq: 0,
  startedAt: null,
};

/** A scripted client: the screen is 1280x720 and every call is recorded. */
export function fakeClient(initial: VscreenStatus = RUNNING): ComputerWatchClient & {
  state: VscreenStatus;
  inputs: VscreenInputEvent[][];
  calls: { frame: (number | undefined)[]; status: number; stop: number; takenOver: boolean[] };
  /** The next frame call reports a new screen (`frameSeq` up by one). */
  nextFrame(image?: string): void;
} {
  let image = TINY_JPEG;
  const c = {
    state: { ...initial },
    inputs: [] as VscreenInputEvent[][],
    calls: { frame: [] as (number | undefined)[], status: 0, stop: 0, takenOver: [] as boolean[] },
    nextFrame(next = TINY_JPEG_2) {
      image = next;
      c.state = { ...c.state, frameSeq: c.state.frameSeq + 1 };
    },
    async status() {
      c.calls.status += 1;
      return c.state;
    },
    async frame(since: number | undefined): Promise<VscreenFrame> {
      c.calls.frame.push(since);
      const { frameSeq, width, height } = c.state;
      const changed = since !== frameSeq;
      return { changed, frameSeq, image: changed ? image : null, width, height };
    },
    async input(events: VscreenInputEvent[]) {
      c.inputs.push(events);
    },
    async setTakenOver(on: boolean) {
      c.calls.takenOver.push(on);
      c.state = { ...c.state, takenOver: on };
    },
    async stop() {
      c.calls.stop += 1;
      c.state = { ...STOPPED };
    },
  };
  return c;
}
