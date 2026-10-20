import { createConnection } from "node:net";
import type { FrameChannel } from "./channel.ts";
import { NdjsonChannel } from "./ndjson.ts";

/** NDJSON over the Gateway's local node socket (`$PSYCHE_HOME/run/node.sock`). */
export function openUnixSocket(path: string): Promise<FrameChannel> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(NdjsonChannel.fromDuplex(`unix:${path}`, socket));
    });
    socket.once("error", reject);
  });
}
