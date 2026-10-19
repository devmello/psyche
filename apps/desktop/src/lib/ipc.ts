/** IPC channel names shared by main and preload (`psyche:<area>:<verb>`). */
export const IPC = {
  getStatus: "psyche:gateway:get-status",
  status: "psyche:gateway:status",
} as const;
