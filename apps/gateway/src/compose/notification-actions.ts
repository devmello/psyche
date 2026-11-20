import type { Notification } from "@psyche/protocol";

/**
 * What a notice's own button does (`notifications.resolve {actionId}`): a part registers a
 * prefix, and an action id `<prefix>:<argument>` runs its handler with the argument. A handler
 * that throws leaves the notice open (the notifier un-resolves it), so the owner can try again.
 * An action no part registered just resolves the notice, as before.
 */
export type NotificationActionHandler = (
  notification: Notification,
  argument: string,
) => void | Promise<void>;

export class NotificationActions {
  readonly #byPrefix = new Map<string, NotificationActionHandler>();

  register(prefix: string, handler: NotificationActionHandler): () => void {
    if (prefix === "" || prefix.includes(":")) throw new Error(`bad action prefix ${prefix}`);
    if (this.#byPrefix.has(prefix)) throw new Error(`action prefix ${prefix} is taken`);
    this.#byPrefix.set(prefix, handler);
    return () => {
      if (this.#byPrefix.get(prefix) === handler) this.#byPrefix.delete(prefix);
    };
  }

  async run(notification: Notification, actionId: string): Promise<void> {
    const at = actionId.indexOf(":");
    const prefix = at === -1 ? actionId : actionId.slice(0, at);
    await this.#byPrefix.get(prefix)?.(notification, at === -1 ? "" : actionId.slice(at + 1));
  }
}
