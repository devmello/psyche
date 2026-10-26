import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactElement, useEffect, useState } from "react";
import { Markdown } from "./Markdown.tsx";

/**
 * Streaming text (smooth-streaming): the same reply delivered as a fast burst and as a slow
 * trickle. Deltas are painted one frame at a time, finished blocks stay put, and the caret
 * follows the tail. Under reduced motion the text appears at once.
 */
const REPLY = `## Plan for the week

Here is what I would do, in order:

1. Clear the **inbox** down to the threads that need you.
2. Move the design review to Thursday.
3. Draft the summary for Friday's sync.

\`\`\`ts
export function plan(days: number): string[] {
  return Array.from({ length: days }, (_, i) => \`day \${i + 1}\`);
}
\`\`\`

| Day | Focus |
| --- | --- |
| Mon | Inbox |
| Thu | Review |

That is the whole plan. Tell me if you want it shorter.
`;

/** Delivers `REPLY` in `size`-character deltas every `every` ms, then loops after a pause. */
function Stream({ size, every }: { size: number; every: number }): ReactElement {
  const [n, setN] = useState(0);
  const done = n >= REPLY.length;
  useEffect(() => {
    const id = setTimeout(
      () => setN(done ? 0 : Math.min(REPLY.length, n + size)),
      done ? 2500 : every,
    );
    return () => clearTimeout(id);
  }, [n, done, size, every]);
  return (
    <div className="bg-canvas p-6" style={{ width: 560, minHeight: 420 }}>
      <Markdown streaming={!done}>{REPLY.slice(0, n)}</Markdown>
    </div>
  );
}

const meta = { title: "Chat/Streaming", component: Stream } satisfies Meta<typeof Stream>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 120 characters every 30 ms: a very fast model, or a burst after a stall. */
export const Fast: Story = { args: { size: 120, every: 30 } };
/** 3 characters every 40 ms: a slow trickle. */
export const Slow: Story = { args: { size: 3, every: 40 } };
