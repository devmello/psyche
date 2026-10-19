import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { emailToText, parseEmail, sanitizeEmailHtml, stripHtml } from "../src/core/email.ts";
import { MALICIOUS_EML, MALICIOUS_HTML } from "./fixtures/email.ts";

const { window } = new JSDOM("");
const win = window as unknown as Window;

describe("email parsing", () => {
  it("parses headers, encoded words, html and attachments", async () => {
    const mail = await parseEmail(new TextEncoder().encode(MALICIOUS_EML));
    expect(mail.subject).toBe("Your invoice ✓");
    expect(mail.from).toEqual({ name: "Billing", address: "billing@shop.example" });
    expect(mail.to.map((a) => a.address)).toEqual(["ada@example.com", "team@example.com"]);
    expect(mail.html).toContain("Your invoice");
    const pdf = mail.attachments.find((a) => a.filename === "invoice.pdf");
    expect(pdf).toMatchObject({ mime: "application/pdf", inline: false });
    expect(new TextDecoder().decode(pdf?.content).startsWith("%PDF")).toBe(true);
    expect(mail.attachments.find((a) => a.contentId === "logo@x")?.inline).toBe(true);
    const text = emailToText(mail, stripHtml);
    expect(text).toContain("Attachments: invoice.pdf (application/pdf");
    expect(text).not.toContain("<script");
  });
});

describe("email sanitizing", () => {
  const clean = sanitizeEmailHtml(MALICIOUS_HTML, {
    window: win,
    resolveCid: (id) => (id === "logo@x" ? "data:image/png;base64,AAAA" : undefined),
  });

  it("removes every active or navigating construct", () => {
    const h = clean.html.toLowerCase();
    for (const bad of ["<script", "<iframe", "<form", "<input", "<object", "<meta", "<base", "<link", "<svg", "onload", "onclick", "javascript:", "file:", "srcset", "@import"]) {
      expect(h, bad).not.toContain(bad);
    }
  });

  it("blocks remote images and CSS urls by default and counts them", () => {
    expect(clean.html).not.toMatch(/\ssrc="https?:/);
    expect(clean.html).not.toContain("url(https://evil.example");
    expect(clean.html).toContain('data-psyche-blocked-src="https://tracker.example/pixel.gif?u=ada"');
    expect(clean.blockedImages).toBeGreaterThanOrEqual(2);
  });

  it("resolves cid images and keeps safe links with noopener", () => {
    expect(clean.html).toContain('src="data:image/png;base64,AAAA"');
    expect(clean.html).toMatch(/<a [^>]*href="https:\/\/shop.example\/pay"[^>]*rel="noopener noreferrer"/);
    // Prompt-injection text survives as inert text: it is data, shown to the user.
    expect(clean.html).toContain("Ignore previous instructions");
    expect(clean.html).not.toContain("data-x");
  });

  it("loads remote images only when asked", () => {
    const loaded = sanitizeEmailHtml(MALICIOUS_HTML, { window: win, allowRemoteImages: true });
    expect(loaded.html).toContain('src="https://tracker.example/pixel.gif?u=ada"');
    expect(loaded.blockedImages).toBe(0);
    expect(loaded.html.toLowerCase()).not.toContain("<script");
  });
});
