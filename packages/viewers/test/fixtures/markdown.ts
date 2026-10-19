/** Common constructs that a lossy Markdown round trip tends to mangle. */
export const ROUND_TRIP_MD = `---
name: Flash
creature: pink hippo   # trailing comment kept
emoji: "🦛"
---

# Core truths

* star bullet list
* second item
  1. nested *ordered* item
  2. __bold underscores__

- [ ] task item
- [x] done task

Setext heading
==============

> quote with **bold** and \`code\`
> second line

| left | right |
|:-----|------:|
| a    |     1 |

\`\`\`ts title="x.ts"
const x = 1;   // spacing kept
\`\`\`

    indented code block

Line with trailing spaces for a hard break  
next line, a [ref link][ref] and <span class="raw">raw HTML</span>.

Footnote reference[^1].

[^1]: The footnote.

[ref]: https://example.com "Title"
`;
