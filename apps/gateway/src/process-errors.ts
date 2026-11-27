import type { Logger } from "./log.ts";

/**
 * What a log line may say about a failure that reached the process level: the error's code and
 * message, nothing else. A rejection can carry a payload or the owner's text in its value, so a
 * non-Error value is logged as its kind only, and the message is cut.
 */
export function failureFields(err: unknown): { code: string; message: string } {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "none";
  const message =
    err instanceof Error ? err.message.slice(0, 200) : `non-error ${typeof err} value`;
  return { code, message };
}

/**
 * `unhandledRejection` for psyched: a rejected promise nobody awaited is logged at error level and
 * the Gateway keeps running. Node's default would exit the process and cut every run in flight.
 */
export function unhandledRejectionHandler(log: Logger): (reason: unknown) => void {
  return (reason) => {
    log.log("error", "unhandled promise rejection", failureFields(reason));
  };
}

/**
 * `uncaughtException` for psyched: the failure is logged, then the same graceful shutdown SIGTERM
 * runs, so launchd restarts the process cleanly instead of leaving it in an unknown state.
 */
export function uncaughtExceptionHandler(
  log: Logger,
  shutdown: (reason: string) => void,
): (err: unknown) => void {
  return (err) => {
    log.log("error", "uncaught exception; shutting down", failureFields(err));
    shutdown("uncaughtException");
  };
}
