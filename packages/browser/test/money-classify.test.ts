import { describe, expect, it } from "vitest";
import { classifyActivation, classifyFormSubmit, classifyKeys } from "../src/tools/classify.ts";
import type { ElementMeta } from "../src/types.ts";

/**
 * Presence is asked for payments and nothing else, so the browser rule is precise both ways:
 * the control that pays is financial, navigation (links, GET forms) and ordinary forms are not.
 */

const base: ElementMeta = {
  ref: "ref_1",
  role: "button",
  name: "",
  tag: "BUTTON",
  inForm: false,
  submits: false,
  secure: false,
  frameOrigin: "https://shop.example",
  opensPopup: false,
};
const submit = (over: Partial<ElementMeta>): ElementMeta => ({
  ...base,
  submits: true,
  inForm: true,
  formMethod: "post",
  ...over,
});
const field = (over: Partial<ElementMeta>): ElementMeta => ({
  ...base,
  role: "textbox",
  tag: "INPUT",
  inForm: true,
  ...over,
});

const PAYS: [string, ElementMeta][] = [
  ["button Place bid", { ...base, name: "Place bid" }],
  ["button Sell", { ...base, name: "Sell" }],
  ["button Swap", { ...base, name: "Swap" }],
  ["button Pay", { ...base, name: "Pay" }],
  ["button Place order", { ...base, name: "Place order" }],
  ["button Confirm and pay", { ...base, name: "Confirm and pay" }],
  [
    "submit in a POST form to /transfer/submit",
    submit({ name: "Go", formAction: "https://bank.example/transfer/submit" }),
  ],
  [
    "submit in a POST form to /checkout",
    submit({ name: "Go", formAction: "https://s.example/checkout" }),
  ],
  [
    "submit in a POST form to /orders/create",
    submit({ name: "Go", formAction: "https://s.example/orders/create" }),
  ],
  [
    "submit in a form with real card fields",
    submit({ name: "Continue", formAction: "https://s.example/step3", formHasPaymentFields: true }),
  ],
  [
    "bare Confirm on a checkout page",
    { ...base, name: "Confirm", pageUrl: "https://s.example/checkout/review" },
  ],
  [
    "bare Send in a form with card fields",
    submit({ name: "Send", formAction: "https://s.example/x", formHasPaymentFields: true }),
  ],
  [
    "bare Continue on a payment-titled page",
    submit({ name: "Continue", formAction: "https://s.example/x", pageTitle: "Review your order" }),
  ],
];

const TAPS: [string, ElementMeta][] = [
  ["link Where to buy", { ...base, role: "link", tag: "A", name: "Where to buy" }],
  ["link Buy tickets", { ...base, role: "link", tag: "A", name: "Buy tickets" }],
  ["link Pay bills", { ...base, role: "link", tag: "A", name: "Pay bills" }],
  ["link Pay", { ...base, role: "link", tag: "A", name: "Pay" }],
  ["link Subscribe", { ...base, role: "link", tag: "A", name: "Subscribe" }],
  ["link Transfer files", { ...base, role: "link", tag: "A", name: "Transfer files" }],
  ["link Proceed to checkout", { ...base, role: "link", tag: "A", name: "Proceed to checkout" }],
  ["button Proceed to checkout", { ...base, name: "Proceed to checkout" }],
  ["button Subscribe", { ...base, name: "Subscribe" }],
  ["button Transfer", { ...base, name: "Transfer" }],
  ["button Checkout (no submit)", { ...base, name: "Checkout" }],
  [
    "GET form /orders/search",
    submit({ name: "Search", formMethod: "get", formAction: "https://s.example/orders/search" }),
  ],
  [
    "GET form /checkout",
    submit({ name: "Go", formMethod: "get", formAction: "https://s.example/checkout" }),
  ],
  [
    "POST form /orders/search",
    submit({ name: "Search", formAction: "https://s.example/orders/search" }),
  ],
  ["POST form /settings", submit({ name: "Save", formAction: "https://s.example/settings" })],
  [
    "bare Send in a mail form",
    submit({
      name: "Send",
      formAction: "https://mail.example/compose",
      pageUrl: "https://mail.example/compose",
    }),
  ],
  [
    "bare Confirm on a settings page",
    {
      ...base,
      name: "Confirm",
      pageUrl: "https://s.example/settings/profile",
      pageTitle: "Profile",
    },
  ],
  [
    "form whose cc/library/pin fields are not card fields",
    submit({ name: "Send", formAction: "https://mail.example/send", formHasPaymentFields: false }),
  ],
];

describe("browser payment classification", () => {
  it.each(PAYS)("%s is financial", (_label, meta) => {
    expect(classifyActivation(meta)).toMatchObject({ sideEffect: "financial", kind: "purchase" });
  });

  it.each(TAPS)("%s is not financial", (_label, meta) => {
    expect(classifyActivation(meta).sideEffect).not.toBe("financial");
  });

  it("Enter in a field of a payment form submits it as a payment; of a GET search it does not", () => {
    const card = field({
      formAction: "https://s.example/step3",
      formMethod: "post",
      formHasPaymentFields: true,
    });
    expect(classifyFormSubmit(card).sideEffect).toBe("financial");
    expect(classifyKeys("Enter", card).sideEffect).toBe("financial");
    const search = field({ formAction: "https://s.example/orders/search", formMethod: "get" });
    expect(classifyFormSubmit(search).sideEffect).toBe("read");
    expect(classifyKeys("Enter", search).sideEffect).toBe("read");
    const post = field({ formAction: "https://bank.example/transfer/submit", formMethod: "post" });
    expect(classifyKeys("Enter", post).sideEffect).toBe("financial");
  });
});
