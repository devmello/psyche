/** Where the main window goes when a pop-up (the ask panel) opens a thread. */
export function threadRoute(threadId: string | null): string {
  return threadId === null ? "/chat" : `/chat/${threadId}`;
}
