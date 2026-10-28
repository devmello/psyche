import type { Meta, StoryObj } from "@storybook/react-vite";
import { Markdown } from "./Markdown.tsx";

/** Every element the chat prose style (`.psy-prose`) covers, in one reply. */
const SOURCE = `# Heading one
Opening paragraph with **bold**, *italic*, \`inline code\` and a [link](https://example.com).

## Heading two
A second paragraph, to show the gap between blocks stays compact.

### Heading three
#### Heading four

- First bullet
- Second bullet with nested items
  - Nested one
  - Nested two
    - Third level
- Third bullet

1. Step one
2. Step two
   1. Sub-step
   2. Another sub-step
3. Step three

- [x] Done task
- [ ] Open task

> A quote with a left rule, set a little softer than body text.

\`\`\`ts
export function greet(name: string): string {
  return \`hello, \${name}\`;
}
\`\`\`

| Day | Focus | Notes |
| --- | --- | --- |
| Mon | Inbox | Clear it down to what needs you |
| Thu | Review | Move the design review here |

---

Closing paragraph.
`;

function Prose({ md, width }: { md: string; width: number }) {
  return (
    <div className="bg-canvas p-6" style={{ width }}>
      <Markdown>{md}</Markdown>
    </div>
  );
}

const meta = { title: "Chat/Prose", component: Prose } satisfies Meta<typeof Prose>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AllElements: Story = { args: { md: SOURCE, width: 640 } };
export const Narrow: Story = { args: { md: SOURCE, width: 340 } };
