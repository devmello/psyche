import type { GatewayStatus } from "@psyche/web/client";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { IPC } from "./lib/ipc.ts";

/**
 * Minimal typed bridge (architecture §5): status only. No Node APIs, no secrets, no generic
 * `invoke`/`send` passthrough reach the renderer.
 */
export interface PsycheBridge {
  getStatus(): Promise<GatewayStatus>;
  /** Subscribe to status updates; returns an unsubscribe function. */
  onStatus(cb: (status: GatewayStatus) => void): () => void;
}

const bridge: PsycheBridge = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<GatewayStatus>,
  onStatus(cb) {
    const listener = (_event: IpcRendererEvent, status: GatewayStatus) => cb(status);
    ipcRenderer.on(IPC.status, listener);
    return () => {
      ipcRenderer.removeListener(IPC.status, listener);
    };
  },
};

contextBridge.exposeInMainWorld("psyche", bridge);
