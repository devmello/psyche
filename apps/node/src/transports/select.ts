import { PsycheError } from "@psyche/protocol";
import type { ChannelFactory, FrameChannel } from "./channel.ts";
import { openUnixSocket } from "./unix.ts";
import { openVsock, type VsockEndpoint } from "./vsock.ts";
import { openWebSocket } from "./ws.ts";

export interface TransportPlan {
  kind: "vsock" | "unix" | "ws";
  describe: string;
  open(): Promise<FrameChannel>;
}

export interface PlanInput {
  url?: string;
  socket?: string;
  vsock?: VsockEndpoint;
  /** Running as a VM guest (`detectVmGuest`). */
  isGuest: boolean;
  /** A Gateway node socket on this machine, used when nothing is configured and it exists. */
  localSocket?: string | undefined;
  defaultUrl: string;
}

export interface TransportOpeners {
  ws(url: string): Promise<FrameChannel>;
  unix(path: string): Promise<FrameChannel>;
  vsock(endpoint: VsockEndpoint): Promise<FrameChannel>;
}

const realOpeners: TransportOpeners = {
  ws: (url) => openWebSocket(url),
  unix: openUnixSocket,
  vsock: openVsock,
};

/**
 * Order of attempts. A VM guest with a vsock endpoint prefers vsock (the NAT address moves
 * between boots, spike 06); configured endpoints come next; with nothing configured, a local
 * Gateway's node socket, then the loopback WebSocket.
 */
export function planTransports(
  input: PlanInput,
  openers: TransportOpeners = realOpeners,
): TransportPlan[] {
  const plans: TransportPlan[] = [];
  const vsock = input.vsock;
  const vsockPlan: TransportPlan | null = vsock
    ? {
        kind: "vsock",
        describe: `vsock:${vsock.cid}:${vsock.port}`,
        open: () => openers.vsock(vsock),
      }
    : null;
  if (vsockPlan && input.isGuest) plans.push(vsockPlan);
  const { socket, url } = input;
  if (socket)
    plans.push({ kind: "unix", describe: `unix:${socket}`, open: () => openers.unix(socket) });
  if (url) plans.push({ kind: "ws", describe: url, open: () => openers.ws(url) });
  if (vsockPlan && !input.isGuest) plans.push(vsockPlan);
  if (plans.length === 0) {
    const local = input.localSocket;
    if (local)
      plans.push({ kind: "unix", describe: `unix:${local}`, open: () => openers.unix(local) });
    plans.push({
      kind: "ws",
      describe: input.defaultUrl,
      open: () => openers.ws(input.defaultUrl),
    });
  }
  return plans;
}

/** Tries each plan in order on every (re)connect; the first that opens wins. */
export function channelFactory(plans: TransportPlan[]): ChannelFactory {
  return async () => {
    const errors: string[] = [];
    for (const plan of plans) {
      try {
        return await plan.open();
      } catch (err) {
        errors.push(`${plan.describe}: ${(err as Error).message}`);
      }
    }
    throw new PsycheError("unavailable", `no Gateway reachable (${errors.join("; ")})`, {
      retryable: true,
    });
  };
}
