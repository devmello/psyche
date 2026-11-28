import { fixtureSecret } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/origin/redact-url.ts";

const PAN = fixtureSecret("link-virtual-card");

describe("card parameters in URLs", () => {
  it("masks card values a GET-submitted card form puts in the URL", () => {
    const out = redactUrl(
      `https://shop.example/pay?cvv=737&cvc=737&csc=737&exp=04%2F31&card=${PAN}&card_number=${PAN}&q=mug`,
    );
    for (const v of ["737", "04%2F31", PAN]) expect(out).not.toContain(v);
    expect(out).toContain("q=mug");
  });
});

describe("more card parameter names", () => {
  it("masks security_code, ccv and expiration", () => {
    const out = redactUrl(
      "https://shop.example/pay?security_code=737&ccv=737&expiration=0431&q=mug",
    );
    expect(out).not.toContain("737");
    expect(out).not.toContain("0431");
    expect(out).toContain("q=mug");
  });
});
