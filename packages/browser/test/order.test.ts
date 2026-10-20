import { describe, expect, it } from "vitest";
import { orderBinding, orderStillMatches, orderSummary, readOrder } from "../src/tools/order.ts";

const CART = `# https://shop-b.example.net/cart "Stand Shop B: cart" refs=3 interactive=2
- heading "Your cart" [ref=ref_1] [level=1] @20,20 600x40
- text "Seller: Stand Shop B"
- table "Cart"
  - row
    - columnheader "Item"
    - columnheader "Qty"
    - columnheader "Price"
  - row
    - cell "Laptop Stand 13-inch"
    - cell "1"
    - cell "$29.00"
  - row
    - cell "USB-C cable \\"2m\\""
    - cell "2"
    - cell "$9.98"
  - row
    - cell "Shipping"
    - cell "$0.00"
- text "Subtotal: $38.98"
- text "Total: $38.98"
- form
  - button "Place order" [ref=ref_2] @20,390 200x30`;

describe("purchase card details (INT-2 scenario 1)", () => {
  it("reads seller, line items and total from the checkout snapshot", () => {
    const o = readOrder(CART, "https://shop-b.example.net");
    expect(o).toMatchObject({
      merchantOrigin: "https://shop-b.example.net",
      seller: "Stand Shop B",
      items: [
        { name: "Laptop Stand 13-inch", quantity: "1", price: "$29.00" },
        { name: 'USB-C cable "2m"', quantity: "2", price: "$9.98" },
      ],
      total: "$38.98",
      amount: "38.98",
      currency: "USD",
    });
    expect(o.lineItemHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(orderSummary("Place order", o)).toBe(
      'Place order on shop-b.example.net; seller "Stand Shop B"; 1 × "Laptop Stand 13-inch" $29.00, 2 × "USB-C cable "2m"" $9.98; total $38.98 (as shown on the page)',
    );
    expect(orderBinding(o, "Place order")).toEqual({
      merchantOrigin: "https://shop-b.example.net",
      amount: "38.98",
      currency: "USD",
      lineItemHash: o.lineItemHash,
      paymentMethodId: null,
      submit: "Place order",
    });
  });

  it("handles totals in table rows, other currencies and pages that state nothing", () => {
    const eu = readOrder(
      `- table "Basket"
  - row
    - cell "Kaffeebohnen 1 kg"
    - cell "1"
    - cell "18,90 €"
  - row
    - cell "Order total"
    - cell "EUR 18.90"
- text "Sold by Rösterei Nord GmbH"`,
      "https://roesterei.example.de",
    );
    expect(eu).toMatchObject({ seller: "Rösterei Nord GmbH", total: "EUR 18.90", currency: "EUR" });
    expect(eu.items).toHaveLength(1);
    const bare = readOrder('- button "Buy now" [ref=ref_1]', "https://x.example");
    expect(bare).toMatchObject({ items: [] });
    expect(bare.total).toBeUndefined();
    expect(orderSummary("Buy now", bare)).toBe(
      "Buy now on x.example; total not shown on the page (as shown on the page)",
    );
  });

  it("strips control and bidi characters and caps page strings", () => {
    const o = readOrder(
      `- text "Seller: Good\\u202eShop\\u0007 ${"x".repeat(200)}"\n- text "Total: $1.00"`,
      "https://a.example",
    );
    expect(o.seller).not.toContain("\u202e");
    expect(o.seller).not.toContain("\u0007");
    expect(o.seller?.length).toBeLessThanOrEqual(80);
  });

  it("notices when the order changes", () => {
    const a = readOrder(CART, "https://shop-b.example.net");
    const pricier = readOrder(
      CART.replace("Total: $38.98", "Total: $99.00"),
      "https://shop-b.example.net",
    );
    const moreItems = readOrder(CART.replace('cell "2"', 'cell "3"'), "https://shop-b.example.net");
    const elsewhere = readOrder(CART, "https://evil.example.org");
    expect(orderStillMatches(a, readOrder(CART, "https://shop-b.example.net"))).toBe(true);
    expect(orderStillMatches(a, pricier)).toBe(false);
    expect(orderStillMatches(a, moreItems)).toBe(false);
    expect(orderStillMatches(a, elsewhere)).toBe(false);
    // What the approved read did not show is not compared (a total below the fold).
    const noTotal = readOrder(
      CART.replace(/- text "(Sub)?[Tt]otal[^\n]*\n?/g, ""),
      "https://shop-b.example.net",
    );
    expect(noTotal.total).toBeUndefined();
    expect(orderStillMatches(noTotal, a)).toBe(true);
    expect(orderStillMatches(noTotal, moreItems)).toBe(false);
  });
});
