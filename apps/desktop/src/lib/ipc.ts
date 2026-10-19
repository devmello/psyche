/**
 * IPC channel names shared by main and preload (`psyche:<area>:<verb>`) and the validators main
 * runs on every renderer payload. The renderer is treated as untrusted input: main checks the
 * sender frame, then the payload shape, before acting.
 */
export const IPC = {
  // Gateway connection (main holds the socket and keys).
  getStatus: "psyche:gateway:get-status",
  status: "psyche:gateway:status",
  call: "psyche:gateway:call",
  event: "psyche:gateway:event",
  resync: "psyche:gateway:resync",
  // Embedded agent browser.
  browserGetState: "psyche:browser:get-state",
  browserState: "psyche:browser:state",
  browserDownload: "psyche:browser:download",
  browserViewport: "psyche:browser:set-viewport",
  browserOpen: "psyche:browser:open",
  browserClose: "psyche:browser:close",
  browserActivate: "psyche:browser:activate",
  browserNavigate: "psyche:browser:navigate",
  browserFind: "psyche:browser:find",
  browserStopFind: "psyche:browser:stop-find",
  browserSetControl: "psyche:browser:set-control",
  browserPopOut: "psyche:browser:pop-out",
  browserClearData: "psyche:browser:clear-data",
  // Terminal.
  terminalOpen: "psyche:terminal:open",
  terminalWrite: "psyche:terminal:write",
  terminalResize: "psyche:terminal:resize",
  terminalClose: "psyche:terminal:close",
  terminalData: "psyche:terminal:data",
  terminalExit: "psyche:terminal:exit",
  // Windows, notifications, native commands.
  windowPopOut: "psyche:window:pop-out",
  windowClose: "psyche:window:close",
  shellCommand: "psyche:shell:command",
  notifyShow: "psyche:notify:show",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export class IpcPayloadError extends Error {
  constructor(channel: string, what: string) {
    super(`invalid ${channel} payload: ${what}`);
    this.name = "IpcPayloadError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(channel: string, v: unknown, name: string, max = 8192): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max)
    throw new IpcPayloadError(channel, `${name} must be a non-empty string ≤ ${max}`);
  return v;
}

export function num(channel: string, v: unknown, name: string, min = 0, max = 100_000): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new IpcPayloadError(channel, `${name} must be a number in [${min}, ${max}]`);
  return v;
}

export function rec(channel: string, v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new IpcPayloadError(channel, "expected an object");
  return v;
}

/** Methods the renderer may call through main: any protocol method except the handshake. */
export function checkCallable(method: unknown, isMethodName: (m: unknown) => boolean): string {
  if (typeof method !== "string" || !isMethodName(method))
    throw new IpcPayloadError(IPC.call, "unknown method");
  if (method === "connect" || method === "connect.verify" || method.startsWith("node."))
    throw new IpcPayloadError(IPC.call, `${method} is not callable from the renderer`);
  return method;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function checkViewport(v: unknown): ViewportRect | null {
  if (v === null) return null;
  const r = rec(IPC.browserViewport, v);
  return {
    x: Math.round(num(IPC.browserViewport, r.x, "x")),
    y: Math.round(num(IPC.browserViewport, r.y, "y")),
    width: Math.round(num(IPC.browserViewport, r.width, "width")),
    height: Math.round(num(IPC.browserViewport, r.height, "height")),
  };
}

/** Only http(s) URLs may be opened in agent tabs (architecture §8). */
export function checkHttpUrl(channel: string, v: unknown): string {
  const s = str(channel, v, "url");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new IpcPayloadError(channel, "url must be absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new IpcPayloadError(channel, "only http and https URLs");
  if (url.username || url.password) throw new IpcPayloadError(channel, "no userinfo in URLs");
  return url.toString();
}

/** Routes the shell may open in a pop-out window (docs/06 §2.7); never a URL. */
export function checkRoute(channel: string, v: unknown): string {
  const s = str(channel, v, "route", 512);
  if (!/^\/[A-Za-z0-9/_\-.:]*$/.test(s) || s.includes(".."))
    throw new IpcPayloadError(channel, "route must be an app path");
  return s;
}
