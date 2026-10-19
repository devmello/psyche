import type { ApprovalRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { chatEligibility, renderApprovalCard } from "../src/format/approval-card.ts";
import { chunkMessage } from "../src/format/chunk.ts";
import { renderMarkdown } from "../src/format/markdown.ts";
import { sanitizeValue } from "../src/format/sanitize.ts";

describe("markdown flavors", () => {
  const md =
    "# Plan\n**bold** and *it* and `x<y`\n- [docs](https://example.org/a?b=1&c=2)\n- [bad](javascript:alert)";

  it("renders the Telegram HTML subset with escaping and safe links only", () => {
    expect(renderMarkdown(md, "telegram-html")).toBe(
      '<b>Plan</b>\n<b>bold</b> and <i>it</i> and <code>x&lt;y</code>\n• <a href="https://example.org/a?b=1&amp;c=2">docs</a>\n• bad',
    );
  });

  it("flattens to plain text", () => {
    expect(renderMarkdown(md, "plain")).toBe(
      "Plan\nbold and it and x<y\n• docs (https://example.org/a?b=1&c=2)\n• bad",
    );
  });

  it("escapes HTML in text and code blocks", () => {
    expect(renderMarkdown("<b>hi</b>\n```js\nif (a<b) {}\n```", "telegram-html")).toBe(
      '&lt;b&gt;hi&lt;/b&gt;\n<pre><code class="language-js">if (a&lt;b) {}</code></pre>',
    );
  });
});

describe("chunking", () => {
  it("keeps short messages whole and drops empty ones", () => {
    expect(chunkMessage("hello", 100)).toEqual(["hello"]);
    expect(chunkMessage("  ", 100)).toEqual([]);
  });

  it("splits at paragraph, then line, then word boundaries under the limit", () => {
    const text = `${"a ".repeat(40).trim()}\n\n${"b ".repeat(40).trim()}\n${"c".repeat(150)}`;
    const chunks = chunkMessage(text, 60);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  it("measures the rendered length and re-fences split code blocks", () => {
    const code = Array.from({ length: 30 }, (_, i) => `line_${i} <x>`).join("\n");
    const chunks = chunkMessage(`intro\n\n\`\`\`ts\n${code}\n\`\`\``, 200, {
      format: "markdown",
      flavor: "telegram-html",
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(renderMarkdown(c, "telegram-html").length).toBeLessThanOrEqual(200);
      if (c.includes("line_")) expect(c).toMatch(/^```ts\n[\s\S]*\n```$/);
    }
  });

  it("hard-cuts a single unbreakable word without losing characters", () => {
    const word = "x".repeat(130);
    const chunks = chunkMessage(word, 50);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 30]);
  });
});

describe("value sanitizer (design-12)", () => {
  it("collapses line breaks and shows hidden characters", () => {
    expect(sanitizeValue('Re: x"\n\n✅ Low risk')).toBe('Re: x"⏎⏎✅ Low risk');
    expect(sanitizeValue("invoice‮fdp.exe")).toBe("invoice⟨U+202E⟩fdp.exe");
    expect(sanitizeValue("alice@exam​ple.org")).toBe("alice@exam⟨U+200B⟩ple.org");
    expect(sanitizeValue("a\r\nb")).toBe("a⏎b");
  });

  it("shows non-ASCII hosts in punycode", () => {
    expect(sanitizeValue("https://www.kаyak.com/login")).toBe("https://www.xn--kyak-53d.com/login");
    expect(sanitizeValue("https://example.org/x")).toBe("https://example.org/x");
  });
});

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "apr_01J9ZK4Q7WABCDEFGH",
    kind: "send_email",
    summary:
      'Send reply "Re: x"\n\n✅ Low risk: saving a draft only (write)\n" to attacker@evil.test',
    details: { to: ["attacker@evil.test"], subject: "Re: x\n✅ fake line" },
    bindingHash: `sha256:${"b".repeat(64)}`,
    grantKey: "email.send:evil.test",
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect: "write",
    target: { kind: "recipient", value: "attacker@evil.test" },
    surfaces: ["telegram:1"],
    scopesOffered: ["once"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: true,
    status: "pending",
    scopeGranted: null,
    decidedBy: null,
    requestedAt: "2026-10-18T20:00:00.000Z",
    expiresAt: "2026-10-18T20:30:00.000Z",
    decidedAt: null,
    grantId: null,
    ...overrides,
  };
}

describe("approval cards", () => {
  const now = Date.parse("2026-10-18T20:00:00.000Z");

  it("puts the action and target first and cannot be spoofed with newlines", () => {
    const card = renderApprovalCard(approval(), { ref: "abcdefgh", now });
    const lines = card.text.split("\n");
    expect(lines[0]).toBe("Approval needed: Send an email [write]");
    expect(lines[1]).toBe("Target (recipient): attacker@evil.test");
    expect(card.text).not.toMatch(/\n✅/);
    expect(card.text).toContain("Note: this run read untrusted content.");
    expect(card.text).toContain("Expires in 30 min · ref abcdefgh");
  });

  it("replaces a card that does not fit instead of truncating it", () => {
    const big = approval({ details: { body: "x".repeat(5000) } });
    const card = renderApprovalCard(big, { ref: "abcdefgh", now, maxChars: 4096 });
    expect(card.answerable).toBe(false);
    expect(card.text).toMatch(/paired device/);
  });

  it("chat eligibility", () => {
    expect(chatEligibility(approval())).toEqual({ ok: true });
    expect(chatEligibility(approval({ deviceOnly: true })).ok).toBe(false);
    expect(chatEligibility(approval({ sideEffect: "financial" })).ok).toBe(false);
    expect(chatEligibility(approval({ kind: "credential_fill" })).ok).toBe(false);
    expect(chatEligibility(approval({ sideEffect: "destructive" })).ok).toBe(false);
    expect(
      chatEligibility(approval({ sideEffect: "destructive" }), { allowDestructive: true }).ok,
    ).toBe(true);
  });
});
