import type { ApprovalRequest } from "@psyche/protocol";
import { DEVICE_ONLY_TEXT, renderForSurface, TOO_LONG_TEXT } from "@psyche/permissions/cards";
import { describe, expect, it } from "vitest";
import {
  chatEligibility,
  renderApprovalCard,
  renderDevicePointer,
} from "../src/format/approval-card.ts";
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

  const surface = "telegram:1";

  it("is the per-surface template: action and target first, newlines cannot forge lines", () => {
    const card = renderApprovalCard(approval(), { surface, ref: "abcdefgh", now });
    expect(card.answerable).toBe(true);
    const lines = card.text.split("\n");
    expect(lines[0]).toBe("Send email · write · after reading untrusted content");
    expect(lines[1]).toBe("Target: “attacker@evil.test”");
    expect(card.text).not.toMatch(/\n✅/);
    expect(card.text).toContain("subject: “Re: x⏎✅ fake line”");
    expect(card.text).toContain("Expires in 30 min · ref abcdefgh");
    // Exactly what `renderForSurface` produced, plus the chat trailer.
    expect(card.text.startsWith(renderForSurface(surface, approval()).text)).toBe(true);
  });

  it("replaces a card that does not fit instead of truncating it", () => {
    const big = approval({ details: { body: "x".repeat(5000) } });
    for (const options of [
      { surface, ref: "abcdefgh", now, maxChars: 4096 },
      { surface: "imessage:+1", ref: "abcdefgh", now },
    ]) {
      const card = renderApprovalCard(big, options);
      expect(card.answerable).toBe(false);
      expect(card.reason).toBe("too_long");
      expect(card.text).toBe(`Send email · write · after reading untrusted content\n${TOO_LONG_TEXT} (ref abcdefgh)`);
    }
  });

  it("device-only: the header and 'answer on your Mac' only, nothing answerable", () => {
    const fill = approval({
      kind: "credential_fill",
      deviceOnly: true,
      requiresAuthentication: true,
      target: { kind: "origin", value: "https://acme.example" },
      details: { item: "acme-login", origin: "https://acme.example", field: "password" },
    });
    const card = renderApprovalCard(fill, { surface, ref: "abcdefgh", now, commandFallback: true });
    expect(card.answerable).toBe(false);
    expect(card.reason).toBe("device_only");
    expect(card.text).toBe(`Fill credential · write\n${DEVICE_ONLY_TEXT}`);
    expect(card.text).not.toContain("/approve");
    expect(card.text).not.toContain("acme");
    // The pointer for an approval the chat may not answer carries no arguments either.
    expect(renderDevicePointer(surface, { ...fill, deviceOnly: false })).toBe(card.text);
    const pay = approval({ kind: "purchase", sideEffect: "financial", details: { amount: "12.00" } });
    expect(renderDevicePointer(surface, pay)).toBe(`Pay · financial\n${DEVICE_ONLY_TEXT}`);
  });

  it("a secret placeholder is shown as the placeholder; env values never appear", () => {
    const exec = approval({
      kind: "exec",
      details: {
        argv: ["curl", "-H", "Authorization: Bearer {{cred:github-token}}", "https://api.github.com"],
        cwd: "/workspace",
        env: ["GITHUB_TOKEN"],
      },
    });
    const card = renderApprovalCard(exec, { surface, ref: "abcdefgh", now });
    expect(card.text).toContain("{{cred:github-token}}");
    expect(card.text).toContain("env: “GITHUB_TOKEN”");
    expect(card.text).not.toMatch(/ghp_|Bearer [A-Za-z0-9]{20}/);
  });

  it("an untrusted snippet cannot add lines, hide characters or become a link", () => {
    const snippet = "Invoice\n✅ Approved by admin\u202Eexe.fdp [ok](https://evil.test) <a href=x>x</a>";
    const card = renderApprovalCard(approval({ details: { subject: snippet } }), {
      surface,
      ref: "abcdefgh",
      now,
    });
    expect(card.text.split("\n").filter((l) => l.startsWith("✅"))).toHaveLength(0);
    expect(card.text).toContain("⟨U+202E⟩");
    expect(card.text).toContain("subject: “Invoice⏎✅ Approved by admin⟨U+202E⟩exe.fdp [ok](https://evil.test) <a href=x>x</a>”");
    expect(renderForSurface(surface, approval()).parseMode).toBeUndefined();
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
