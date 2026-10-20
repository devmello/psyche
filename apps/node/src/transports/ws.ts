import { MAX_FRAME_BYTES, PsycheError } from "@psyche/protocol";
import WebSocket from "ws";
import { ChannelEvents, type FrameChannel } from "./channel.ts";

/**
 * WebSocket to the Gateway's `/ws` (loopback, tailnet or an SSH tunnel). Native clients send no
 * `Origin` header, which is what the Gateway expects from a node (security §10). The URL never
 * carries a token: authority comes from the signed challenge.
 */
export function openWebSocket(url: string, connectTimeoutMs = 10_000): Promise<FrameChannel> {
  const target = new URL(url);
  if (target.protocol !== "ws:" && target.protocol !== "wss:") {
    throw new PsycheError("invalid_params", `gateway URL must be ws:// or wss:// (got ${url})`);
  }
  if (target.username || target.password || target.search) {
    throw new PsycheError("invalid_params", "gateway URL must not carry credentials or a query");
  }
  if (target.pathname === "/" || target.pathname === "") target.pathname = "/ws";
  const describe = `${target.protocol}//${target.host}${target.pathname}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target, {
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: connectTimeoutMs,
      perMessageDeflate: false,
    });
    const events = new ChannelEvents();
    const channel: FrameChannel = {
      describe,
      send(frame) {
        if (!events.closed && socket.readyState === WebSocket.OPEN) socket.send(frame);
      },
      onFrame: (l) => events.onFrame(l),
      onClose: (l) => events.onClose(l),
      close(reason = "closed") {
        events.emitClose(reason);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, reason.slice(0, 120));
        }
      },
    };
    socket.on("open", () => resolve(channel));
    socket.on("message", (data, isBinary) => {
      if (isBinary) return channel.close("binary frame");
      events.emitFrame(data.toString());
    });
    socket.on("close", (code, reason) =>
      events.emitClose(reason.toString() || `websocket closed (${code})`),
    );
    socket.on("error", (err) => {
      if (socket.readyState === WebSocket.CONNECTING) reject(err);
      events.emitClose(err.message);
    });
  });
}
