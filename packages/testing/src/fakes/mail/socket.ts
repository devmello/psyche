/**
 * In-memory byte socket pair for the fake IMAP / SMTP servers: what one side writes, the other
 * reads. Structurally the connectors package's `MailSocket`.
 */
export interface FakeMailSocket {
  readonly readable: AsyncIterable<Uint8Array>;
  write(data: Uint8Array | string): Promise<void>;
  end(): void;
  destroy(): void;
}

function channel() {
  const queue: Uint8Array[] = [];
  let waiting: (() => void) | undefined;
  let ended = false;
  const wake = () => {
    const w = waiting;
    waiting = undefined;
    w?.();
  };
  const readable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          for (;;) {
            const chunk = queue.shift();
            if (chunk !== undefined) return { value: chunk, done: false };
            if (ended) return { value: undefined as never, done: true };
            await new Promise<void>((r) => {
              waiting = r;
            });
          }
        },
      };
    },
  };
  return {
    readable,
    write: async (data: Uint8Array | string) => {
      if (ended) throw new Error("socket closed");
      queue.push(typeof data === "string" ? Buffer.from(data, "latin1") : Buffer.from(data));
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
  };
}

export function fakeSocketPair(): { client: FakeMailSocket; server: FakeMailSocket } {
  const toClient = channel();
  const toServer = channel();
  const destroy = () => {
    toClient.end();
    toServer.end();
  };
  return {
    client: { readable: toClient.readable, write: toServer.write, end: toServer.end, destroy },
    server: { readable: toServer.readable, write: toClient.write, end: toClient.end, destroy },
  };
}

/** Line reader for the server side (CRLF lines, raw byte literals). */
export class FakeLineReader {
  readonly #iter: AsyncIterator<Uint8Array>;
  #buf: Buffer = Buffer.alloc(0);
  #closed = false;

  constructor(socket: FakeMailSocket) {
    this.#iter = socket.readable[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    if (this.#closed) return false;
    const r = await this.#iter.next();
    if (r.done === true) {
      this.#closed = true;
      return false;
    }
    this.#buf = Buffer.concat([this.#buf, Buffer.from(r.value)]);
    return true;
  }

  async readLine(): Promise<string | undefined> {
    for (;;) {
      const i = this.#buf.indexOf("\n");
      if (i >= 0) {
        const line = this.#buf.subarray(0, i).toString("latin1").replace(/\r$/, "");
        this.#buf = this.#buf.subarray(i + 1);
        return line;
      }
      if (!(await this.#fill())) {
        if (this.#buf.length === 0) return undefined;
        const line = this.#buf.toString("latin1");
        this.#buf = Buffer.alloc(0);
        return line;
      }
    }
  }

  async readBytes(n: number): Promise<Uint8Array> {
    while (this.#buf.length < n) {
      if (!(await this.#fill())) throw new Error("closed mid-literal");
    }
    const out = new Uint8Array(this.#buf.subarray(0, n));
    this.#buf = this.#buf.subarray(n);
    return out;
  }
}
