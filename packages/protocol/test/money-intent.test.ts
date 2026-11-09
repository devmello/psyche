import { describe, expect, it } from "vitest";
import {
  isAmbiguousActionLabel,
  isMoneyContext,
  isMoneyFormAction,
  isMoneyText,
  isMoneyToolName,
  isPaymentField,
} from "../src/money-intent.ts";

/**
 * Presence is asked for payments and nothing else, so the rule is precise both ways: the real
 * payments below must classify, and the ordinary actions that share a word with them must not.
 */

const PAYMENT_LABELS = [
  "Pay",
  "Pay now",
  "Send $50",
  "Confirm and send",
  "Place bid",
  "Sell",
  "Swap",
  "Tip",
  "Place order",
  "Place your order",
  "Buy now",
  "Complete purchase",
  "Confirm and pay",
  "Pay with Apple Pay",
  "Send money",
  "Withdraw $200",
  "Withdraw funds",
  "Transfer funds",
  "Transfer $1,000 to savings",
  "Sell 10 shares",
  "Swap tokens",
  "Buy",
  "Donate",
  "Subscribe for $9.99 a month",
];
const ORDINARY_LABELS = [
  "Checkout",
  "Check Out Branch",
  "Transfer",
  "Subscribe",
  "Withdraw invitation",
  "Apple Pay",
  "Where to buy",
  "Buy tickets",
  "Pay bills",
  "Transfer files",
  "Proceed to checkout",
  "Order history",
  "Book a demo",
  "Send",
  "Send message",
  "Send an adaptive card",
  "Search orders",
  "Sort order",
  "Create invoice",
  "Subscribe to channel",
  "Tip of the day",
];

describe("isMoneyText on labels", () => {
  it.each(PAYMENT_LABELS)("%s is a payment", (label) => {
    expect(isMoneyText(label)).toBe(true);
  });
  it.each(ORDINARY_LABELS)("%s is not", (label) => {
    expect(isMoneyText(label)).toBe(false);
  });
});

const PAYMENT_TOOLS: [string, string | undefined][] = [
  ["send_money", undefined],
  ["execute_trade", undefined],
  ["execute", "Places a stock market order"],
  ["swap_tokens", undefined],
  ["sell_stock", undefined],
  ["submit", "Submits the cart"],
  ["pay_invoice", undefined],
  ["place_order", undefined],
  ["createPaymentIntent", "Charges the customer's credit card"],
  ["withdraw_funds", undefined],
];
const ORDINARY_TOOLS: [string, string | undefined][] = [
  ["git_checkout", "Checks out a branch"],
  ["transfer_file", "Transfers a file to another folder"],
  ["transfer_issue", "Moves an issue to another project"],
  ["subscribe_to_channel", "Subscribes to a channel"],
  ["set_sort_order", "Sets the sort order of a list"],
  ["create_invoice", "Creates a draft invoice"],
  ["post_message", "Sends an adaptive card"],
  ["attach", "Adds a card attachment to the message"],
  ["list_orders", "Lists the orders"],
  ["get_payment", "Reads a payment"],
];

describe("tool names and descriptions", () => {
  it.each(PAYMENT_TOOLS)("%s (%s) moves money", (name, description) => {
    expect(isMoneyToolName(name) || isMoneyText(description)).toBe(true);
  });
  it.each(ORDINARY_TOOLS)("%s (%s) does not", (name, description) => {
    expect(isMoneyToolName(name) || isMoneyText(description)).toBe(false);
  });
});

describe("browser forms and pages", () => {
  it("a POST to a transfer or checkout path pays; a GET or a search does not", () => {
    expect(isMoneyFormAction("post", "https://bank.example/transfer/submit")).toBe(true);
    expect(isMoneyFormAction("POST", "/checkout")).toBe(true);
    expect(isMoneyFormAction(undefined, "/orders/create")).toBe(true);
    expect(isMoneyFormAction("get", "/orders/search")).toBe(false);
    expect(isMoneyFormAction("post", "/orders/search")).toBe(false);
    expect(isMoneyFormAction("get", "/checkout")).toBe(false);
    expect(isMoneyFormAction("post", "/settings/profile")).toBe(false);
  });

  it("card fields are real card fields, not cc, library cards or pins", () => {
    expect(isPaymentField({ autocomplete: "cc-number" })).toBe(true);
    expect(isPaymentField({ autocomplete: "cc-exp" })).toBe(true);
    expect(isPaymentField({ autocomplete: "cc-csc" })).toBe(true);
    expect(isPaymentField({ name: "card_number" })).toBe(true);
    expect(isPaymentField({ name: "cardNumber" })).toBe(true);
    expect(isPaymentField({ id: "cvv" })).toBe(true);
    expect(isPaymentField({ label: "Security code" })).toBe(true);
    expect(isPaymentField({ placeholder: "Card number" })).toBe(true);
    expect(isPaymentField({ name: "cc" })).toBe(false);
    expect(isPaymentField({ name: "_cc" })).toBe(false);
    expect(isPaymentField({ name: "cc_recipients" })).toBe(false);
    expect(isPaymentField({ name: "library-card" })).toBe(false);
    expect(isPaymentField({ name: "library_card_number" })).toBe(false);
    expect(isPaymentField({ name: "card_pin" })).toBe(false);
    expect(isPaymentField({ autocomplete: "email" })).toBe(false);
  });

  it("a bare Confirm or Send is a payment only inside a payment page or form", () => {
    expect(isAmbiguousActionLabel("Confirm")).toBe(true);
    expect(isAmbiguousActionLabel("Send")).toBe(true);
    expect(isAmbiguousActionLabel("Pay")).toBe(false);
    expect(isMoneyContext({ url: "https://shop.example/checkout/review" })).toBe(true);
    expect(isMoneyContext({ title: "Review your order" })).toBe(true);
    expect(isMoneyContext({ hasPaymentFields: true })).toBe(true);
    expect(isMoneyContext({ url: "https://mail.example/compose", title: "New message" })).toBe(
      false,
    );
  });
});
