import type { TelegramAdapter, TelegramAdapterOptions } from "@psyche/channels";

/**
 * A stand-in for api.telegram.org (no network): the Telegram adapter's grammY client is given
 * this transformer, which records every Bot API call and answers with envelopes shaped like the
 * recorded fixtures in `packages/channels/test/fixtures/telegram`. Updates are built here and
 * fed through `TelegramAdapter.handleUpdate`, as webhook mode would. All ids are invented.
 */

export type Update = Parameters<TelegramAdapter["handleUpdate"]>[0];
type Transformer = NonNullable<TelegramAdapterOptions["transformer"]>;
type BotInfo = NonNullable<TelegramAdapterOptions["botInfo"]>;

export const BOT_USERNAME = "psyche_int2_bot";
export const BOT_INFO = {
  id: 7_000_000_001,
  is_bot: true,
  first_name: "Psyche",
  username: BOT_USERNAME,
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as BotInfo;
export const FAKE_TOKEN = "123456:INT2-FAKE-TOKEN";

export interface Person {
  id: number;
  first_name: string;
  username: string;
}
export const OWNER: Person = { id: 48_151_623, first_name: "Ada", username: "ada_l" };
export const STRANGER: Person = { id: 99_887_766, first_name: "Mallory", username: "mal" };

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
  at: number;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
}

export interface Button {
  text: string;
  callback_data: string;
}

export class FakeBotApi {
  readonly calls: ApiCall[] = [];
  #nextMessageId = 900;
  #nextUpdateId = 871_300_000;
  #waiters = new Set<() => void>();

  readonly transformer: Transformer = (async (
    _prev: unknown,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<Envelope> => {
    this.calls.push({ method, payload, at: Date.now() });
    for (const w of this.#waiters) w();
    switch (method) {
      case "getMe":
        return { ok: true, result: BOT_INFO };
      case "sendMessage":
        return {
          ok: true,
          result: {
            message_id: ++this.#nextMessageId,
            from: { id: BOT_INFO.id, is_bot: true, first_name: "Psyche", username: BOT_USERNAME },
            chat: { id: Number(payload.chat_id), type: "private" },
            date: Math.floor(Date.now() / 1000),
            text: String(payload.text ?? ""),
          },
        };
      case "answerCallbackQuery":
      case "sendChatAction":
        return { ok: true, result: true };
      default:
        return { ok: false, error_code: 404, description: `Not Found: ${method}` };
    }
  }) as unknown as Transformer;

  /** Texts the bot sent to `chatId`, in order. */
  sent(chatId: number): ApiCall[] {
    return this.calls.filter(
      (c) => c.method === "sendMessage" && Number(c.payload.chat_id) === chatId,
    );
  }

  get mark(): number {
    return this.calls.length;
  }

  /** The first `sendMessage` to `chatId` after `from` whose text matches. */
  message(chatId: number, match: RegExp | ((c: ApiCall) => boolean), from = 0): Promise<ApiCall> {
    const pred =
      typeof match === "function" ? match : (c: ApiCall) => match.test(String(c.payload.text));
    return this.until(
      () =>
        this.calls
          .slice(from)
          .find(
            (c) => c.method === "sendMessage" && Number(c.payload.chat_id) === chatId && pred(c),
          ),
      `sendMessage to ${chatId} matching ${String(match)}`,
    );
  }

  until<T>(pred: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = pred();
        if (v !== undefined) {
          this.#waiters.delete(check);
          clearTimeout(timer);
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        const seen = this.calls.map((c) => `${c.method}:${String(c.payload.text ?? "")}`);
        reject(new Error(`timed out waiting for ${label}; calls: ${seen.join(" | ")}`));
      }, timeoutMs);
      this.#waiters.add(check);
      check();
    });
  }

  // --- updates -------------------------------------------------------------------------------

  dm(from: Person, text: string, messageId = this.#nextUpdateId % 10_000): Update {
    return {
      update_id: ++this.#nextUpdateId,
      message: {
        message_id: messageId,
        from: { ...from, is_bot: false },
        chat: {
          id: from.id,
          first_name: from.first_name,
          username: from.username,
          type: "private",
        },
        date: Math.floor(Date.now() / 1000),
        text,
        ...(text.startsWith("/")
          ? {
              entities: [
                { type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 1 },
              ],
            }
          : {}),
      },
    } as Update;
  }

  edit(from: Person, messageId: number, text: string): Update {
    return {
      update_id: ++this.#nextUpdateId,
      edited_message: {
        message_id: messageId,
        from: { ...from, is_bot: false },
        chat: {
          id: from.id,
          first_name: from.first_name,
          username: from.username,
          type: "private",
        },
        date: Math.floor(Date.now() / 1000) - 5,
        edit_date: Math.floor(Date.now() / 1000),
        text,
      },
    } as Update;
  }

  /** A button press by `from` on a card the bot sent to `chatId`. */
  press(from: Person, chatId: number, card: ApiCall, label: "Approve" | "Deny"): Update {
    const button = keyboard(card).find((b) => b.text === label);
    if (button === undefined) throw new Error(`no ${label} button`);
    return {
      update_id: ++this.#nextUpdateId,
      callback_query: {
        id: String(4_382_195_732_918_475_000 + this.#nextUpdateId),
        from: { ...from, is_bot: false },
        message: {
          message_id: 901,
          from: { id: BOT_INFO.id, is_bot: true, first_name: "Psyche", username: BOT_USERNAME },
          chat: { id: chatId, type: "private", first_name: "Ada" },
          date: Math.floor(Date.now() / 1000),
          text: String(card.payload.text),
        },
        chat_instance: "-7354920111648392011",
        data: button.callback_data,
      },
    } as Update;
  }
}

export function keyboard(call: ApiCall): Button[] {
  const markup = call.payload.reply_markup as { inline_keyboard?: Button[][] } | undefined;
  return markup?.inline_keyboard?.flat() ?? [];
}
