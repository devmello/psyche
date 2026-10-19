import { createInterface } from "node:readline";

/** Interactive input. Secrets are read without echo and never come from argv (security §4). */
export interface Prompter {
  readonly interactive: boolean;
  text(question: string, fallback?: string): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
}

/** Reads all of stdin (for `--secret-stdin`, `vault import -`). */
export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

export function ttyPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Prompter {
  const interactive = Boolean(input.isTTY);
  const ask = (question: string, mute: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      if (!interactive) {
        reject(new Error("This command needs a terminal for input; use the non-interactive flags"));
        return;
      }
      const rl = createInterface({ input, output, terminal: true });
      if (mute) {
        // Suppress echo: readline writes typed characters through _writeToOutput.
        const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
        output.write(question);
        anyRl._writeToOutput = (s: string) => {
          if (s.includes("\n") || s.includes("\r")) output.write("\n");
        };
        rl.question("", (answer) => {
          rl.close();
          resolve(answer);
        });
      } else {
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      }
    });
  return {
    interactive,
    async text(question, fallback) {
      const answer = (await ask(`${question}${fallback ? ` [${fallback}]` : ""}: `, false)).trim();
      return answer || fallback || "";
    },
    secret: (question) => ask(`${question}: `, true),
    async confirm(question, fallback = false) {
      const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `, false))
        .trim()
        .toLowerCase();
      if (!answer) return fallback;
      return answer === "y" || answer === "yes";
    },
  };
}

/** Scripted answers for tests and `--yes` runs. */
export function scriptedPrompter(answers: string[], interactive = true): Prompter {
  const queue = [...answers];
  const next = (q: string) => {
    const a = queue.shift();
    if (a === undefined) throw new Error(`no scripted answer for: ${q}`);
    return a;
  };
  return {
    interactive,
    text: async (q, fallback) => next(q) || fallback || "",
    secret: async (q) => next(q),
    confirm: async (q, fallback = false) => {
      const a = next(q).toLowerCase();
      return a ? a === "y" || a === "yes" : fallback;
    },
  };
}
