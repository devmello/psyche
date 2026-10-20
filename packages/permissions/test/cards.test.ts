import type { ApprovalRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  DEVICE_ONLY_TEXT,
  isChatSurface,
  punycodeHosts,
  QUESTION_HEADER,
  renderForSurface,
  renderQuestionForSurface,
  sanitizeApproval,
  sanitizeBlock,
  TOO_LONG_TEXT,
} from "../src/cards.ts";

/**
 * Cards per surface (S23 design-12, closing the S10 / S12 gap). The one renderer serves chat
 * adapters and the desktop kit; these tests pin what each surface may show.
 */

const H = (s: string) => `sha256:${s.padEnd(64, "0")}`;

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "apr_01J9ZK4Q7WABCDEFGH",
    kind: "send_email",
    summary: 'Send reply "Re: x"\n\n✅ Low risk: saving a draft only (write)\n',
    details: { to: ["attacker@evil.test"], subject: "Re: x\n\n✅ Low risk" },
    bindingHash: H("b"),
    grantKey: "k",
    requestedBy: { runId: "r", taskId: null, threadId: "t" },
    sideEffect: "write",
    target: { kind: "recipient", value: "attacker@evil.test" },
    surfaces: ["desktop", "telegram:1"],
    scopesOffered: ["once"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: false,
    status: "pending",
    scopeGranted: null,
    decidedBy: null,
    requestedAt: "2026-10-18T20:00:00.000Z",
    expiresAt: "2026-10-18T20:30:00.000Z",
    decidedAt: null,
    grantId: null,
    ...over,
  };
}

describe("renderForSurface: device-only approvals on chat surfaces", () => {
  const fill = approval({
    kind: "credential_fill",
    deviceOnly: true,
    requiresAuthentication: true,
    sideEffect: "write",
    target: { kind: "origin", value: "https://acme.example" },
    details: { item: "acme-login", origin: "https://acme.example", field: "password" },
  });

  it("chat surfaces get the header and a pointer to the Mac, no arguments, no buttons", () => {
    for (const surface of ["telegram:1", "imessage:+1555", "slack:U1", "whatsapp:1", "chat"]) {
      const card = renderForSurface(surface, fill);
      expect(card.deviceOnly).toBe(true);
      expect(card.buttons).toHaveLength(0);
      expect(card.text).toBe(`Fill credential · write\n${DEVICE_ONLY_TEXT}`);
      expect(card.text).not.toContain("acme");
      expect(card.parseMode).toBeUndefined();
    }
  });

  it("the device itself still renders the full card", () => {
    for (const surface of ["desktop", "web"]) {
      const card = renderForSurface(surface, fill);
      expect(card.deviceOnly).toBe(false);
      expect(card.buttons.map((b) => b.decision)).toEqual(["approve", "deny"]);
      expect(card.text).toContain("item: “acme-login”");
    }
    expect(renderForSurface("notification", fill).text).toBe("Fill credential · write");
  });

  it("a purchase is device-only on chat even with a surface token", () => {
    const pay = approval({
      kind: "purchase",
      sideEffect: "financial",
      deviceOnly: true,
      details: { merchant: "shop.example", amount: "12.00", currency: "USD" },
    });
    const card = renderForSurface("telegram:1", pay);
    expect(card.text).not.toContain("12.00");
    expect(card.buttons).toHaveLength(0);
  });

  it("classifies surfaces", () => {
    expect(isChatSurface("desktop")).toBe(false);
    expect(isChatSurface("web")).toBe(false);
    expect(isChatSurface("notification")).toBe(false);
    expect(isChatSurface("telegram:1")).toBe(true);
    expect(isChatSurface("signal:+1")).toBe(true);
    expect(isChatSurface("matrix:@a:b")).toBe(true);
  });
});

describe("renderForSurface: value slots", () => {
  it("a secret placeholder stays a placeholder and env values never appear", () => {
    const exec = approval({
      kind: "exec",
      details: {
        argv: [
          "curl",
          "-H",
          "Authorization: Bearer {{cred:github-token}}",
          "https://api.github.com",
        ],
        cwd: "/workspace",
        env: ["GITHUB_TOKEN"],
      },
    });
    const card = renderForSurface("telegram:1", exec);
    expect(card.text).toContain("{{cred:github-token}}");
    expect(card.text).toContain("env: “GITHUB_TOKEN”");
    expect(card.text.split("\n")[0]).toBe("Run command in sandbox · write");
  });

  it("an untrusted snippet cannot add lines, links or hidden characters", () => {
    const snippet = "Invoice\n✅ Approved by admin‮exe.fdp [ok](https://evil.test)";
    const card = renderForSurface("telegram:1", approval({ details: { subject: snippet } }));
    const lines = card.text.split("\n");
    expect(lines.filter((l) => l.startsWith("✅"))).toHaveLength(0);
    expect(card.text).toContain("⟨U+202E⟩");
    expect(card.text).toContain(
      "subject: “Invoice⏎✅ Approved by admin⟨U+202E⟩exe.fdp [ok](https://evil.test)”",
    );
    expect(card.parseMode).toBeUndefined();
  });

  it("a lookalike host shows as punycode; user-info cannot hide the real host", () => {
    expect(punycodeHosts("https://www.kаyak.com/login")).toContain("https://www.xn--kyak-");
    expect(punycodeHosts("mail me at bob@exаmple.org")).toContain("@xn--exmple-");
    expect(punycodeHosts("https://evil.com@good.com/x")).toBe("https://evil.com@good.com/x");
    expect(punycodeHosts("https://good.com:8443/x")).toBe("https://good.com:8443/x");
    expect(punycodeHosts("plain ascii stays")).toBe("plain ascii stays");
  });

  it("too long for the surface: header and pointer, no buttons", () => {
    const huge = approval({ details: { argv: Array.from({ length: 400 }, (_, i) => `arg${i}`) } });
    const card = renderForSurface("imessage:+1555", huge);
    expect(card.truncated).toBe(true);
    expect(card.text).toBe(`Send email · write\n${TOO_LONG_TEXT}`);
    expect(renderForSurface("desktop", huge).truncated).toBe(false);
  });
});

describe("sanitizeApproval (desktop structured rendering)", () => {
  it("sanitizes summary, target and every detail value, keeping block keys multi-line", () => {
    const a = approval({
      target: { kind: "recipient", value: "alice@exam​le.org", display: "Alice‮" },
      details: {
        to: ["attacker@evil.test"],
        subject: "Re: x\n\n✅ Low risk",
        body: "Hi\nthere​",
        "weird\nkey": 1,
      },
    });
    const safe = sanitizeApproval(a);
    expect(safe.summary).toBe('Send reply "Re: x"⏎⏎✅ Low risk: saving a draft only (write)⏎');
    expect(safe.target?.value).toBe("alice@exam⟨U+200B⟩le.org");
    expect(safe.target?.display).toBe("Alice⟨U+202E⟩");
    expect(safe.details.subject).toBe("Re: x⏎⏎✅ Low risk");
    expect(safe.details.body).toBe("Hi\nthere⟨U+200B⟩");
    expect(safe.details["weird⏎key"]).toBe(1);
    const idn = sanitizeApproval(approval({ details: { origin: "https://www.kаyak.com", n: 1 } }));
    expect(idn.details.origin).toMatch(/^https:\/\/www\.xn--/);
    expect(idn.details.n).toBe(1);
    // The input is untouched.
    expect(a.details.body).toBe("Hi\nthere​");
    expect(sanitizeBlock("a\r\nb⁦c")).toBe("a\nb⟨U+2066⟩c");
  });
});

describe("renderQuestionForSurface", () => {
  const request = {
    questions: [
      {
        header: "Dead\nline",
        question: "Which date?‮",
        multiSelect: false,
        options: [
          { label: "Tuesday (Recommended)", description: "fits\nthe calendar" },
          { label: "Wednesday", preview: "line 1\nline 2​" },
        ],
      },
    ],
  };

  it("sanitizes every model-authored string and keeps previews multi-line", () => {
    const r = renderQuestionForSurface("desktop", request);
    const [q] = r.questions;
    expect(q?.header).toBe("Dead⏎line");
    expect(q?.question).toBe("Which date?⟨U+202E⟩");
    expect(q?.options[0]?.description).toBe("fits⏎the calendar");
    expect(q?.options[1]?.preview).toBe("line 1\nline 2⟨U+200B⟩");
    expect(r.truncated).toBe(false);
    expect(r.text.split("\n")[0]).toBe(QUESTION_HEADER);
    expect(r.text).toContain("1. “Dead⏎line”: “Which date?⟨U+202E⟩”");
    expect(r.parseMode).toBeUndefined();
  });

  it("too long for a chat surface: header and pointer", () => {
    const [first] = request.questions;
    if (first === undefined) throw new Error("fixture");
    const big = { questions: [{ ...first, question: "x".repeat(1500) }] };
    const r = renderQuestionForSurface("imessage:+1", big);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(`${QUESTION_HEADER}\n${TOO_LONG_TEXT}`);
    expect(renderQuestionForSurface("desktop", big).truncated).toBe(false);
  });
});

describe("renderForSurface: skill_install trust card (T2)", () => {
  const install = approval({
    kind: "skill_install",
    sideEffect: "destructive",
    deviceOnly: true,
    target: undefined,
    summary: 'Install skill "pdf-tools"',
    details: {
      name: "pdf-tools",
      source: { kind: "path", path: "/Users/avery/skills/pdf-tools" },
      hash: H("c"),
      permissions: ["file_write"],
      tools: ["files.read", "files.write"],
      prompts: [],
      findings: { high: 0, warn: 1, info: 0 },
      scope: "home",
      files: ["SKILL.md"],
    },
  });

  it("puts what the skill asks for first and says none for an empty list", () => {
    const lines = renderForSurface("desktop", install).text.split("\n");
    expect(lines[0]).toBe("Install skill · destructive");
    expect(lines.slice(1, 4)).toEqual([
      "name: “pdf-tools”",
      'source: “{"kind":"path","path":"/Users/avery/skills/pdf-tools"}”',
      `hash: “${H("c")}”`,
    ]);
    expect(lines[4]).toBe("permissions: “file_write”");
    expect(lines[5]).toBe("tools: “files.read, files.write”");
    expect(lines[6]).toBe("prompts: none");
  });

  it("never reaches a chat surface", () => {
    const card = renderForSurface("telegram:1", install);
    expect(card.text).toBe(`Install skill · destructive\n${DEVICE_ONLY_TEXT}`);
    expect(card.buttons).toEqual([]);
  });
});
