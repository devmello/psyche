import { financialBlock } from "@psyche/protocol/financial-block";
import { describe, expect, it } from "vitest";
import { classifyKeys } from "../src/tools/classify.ts";
import { browserToolDefs } from "../src/tools/register.ts";
import type { ElementMeta } from "../src/types.ts";

/**
 * What the browser tools tell the broker about the control they act on, and that the hard block
 * (`@psyche/protocol/financial-block`) refuses the trade or transfer from it. Each row is a hole
 * the round-1 review of #1321 found.
 */

const el = (name: string, more: Partial<ElementMeta> = {}): ElementMeta => ({
  ref: "r",
  role: "button",
  name,
  tag: "button",
  inForm: false,
  submits: false,
  secure: false,
  frameOrigin: "https://robinhood.com",
  opensPopup: false,
  ...more,
});

function tools(origin: string, elements: Record<string, ElementMeta>, dialog?: string) {
  const driver = {
    peek: (_tab: string, ref: string) => elements[ref],
    tabOrigin: () => origin,
    peekSnapshot: () => undefined,
    pendingDialog: () =>
      dialog === undefined ? undefined : { type: "confirm" as const, message: dialog },
  };
  const defs = browserToolDefs({ driver, broker: {} } as never) as unknown as {
    name: string;
    describe?: (p: unknown) => {
      meta?: { control?: Record<string, unknown> };
      sideEffect?: string;
    };
  }[];
  return (name: string, params: unknown) => {
    const d = defs.find((t) => t.name === name)?.describe?.(params);
    expect(d, `${name} has a describe`).toBeDefined();
    return d as NonNullable<typeof d>;
  };
}

/** The hard block on what a described call tells the broker (the same fields `isFinancialControl` reads). */
function blocked(origin: string, d: { meta?: { control?: Record<string, unknown> } }): boolean {
  const c = (d.meta?.control ?? {}) as Parameters<typeof financialBlock>[0];
  return financialBlock({ ...c, origin }) !== undefined;
}

const ROBIN = "https://robinhood.com";

describe("browser tools: what the hard block reads", () => {
  it("browser.drag has a describe: a drag from Buy to Buy is a click on it", () => {
    const run = tools(ROBIN, { a: el("Buy"), b: el("Buy") });
    expect(
      blocked(ROBIN, run("browser.drag", { tabId: "t", from: { ref: "a" }, to: { ref: "b" } })),
    ).toBe(true);
  });

  it("browser.drag onto a Buy button is refused too", () => {
    const run = tools(ROBIN, { a: el("Chart"), b: el("Buy") });
    expect(
      blocked(ROBIN, run("browser.drag", { tabId: "t", from: { ref: "a" }, to: { ref: "b" } })),
    ).toBe(true);
  });

  it("browser.drag by point on a venue is unreadable and refused", () => {
    const run = tools(ROBIN, { a: el("Chart") });
    const d = run("browser.drag", { tabId: "t", from: { ref: "a" }, to: { x: 5, y: 5 } });
    expect(d.meta?.control?.unreadable).toBe(true);
    expect(blocked(ROBIN, d)).toBe(true);
  });

  it("browser.drag of a slider on a shop is not refused", () => {
    const shop = "https://shop.example.com";
    const run = tools(shop, { a: el("Price", { role: "slider" }), b: el("Max") });
    expect(
      blocked(shop, run("browser.drag", { tabId: "t", from: { ref: "a" }, to: { ref: "b" } })),
    ).toBe(false);
  });

  it.each(["Shift+Enter", "Alt+Enter", "Shift+Space", "Alt+Space", "Control+Shift+Enter"])(
    "browser.press %s with no ref activates: refused on a bank",
    (keys) => {
      const bank = "https://secure.chase.com";
      const run = tools(bank, {});
      const d = run("browser.press", { tabId: "t", keys });
      expect(d.meta?.control?.unreadable).toBe(true);
      expect(blocked(bank, d)).toBe(true);
      // and the same chord with no ref is a write, never a read (it skipped the Pay card too)
      expect(d.sideEffect).toBe("write");
    },
  );

  it.each(["Tab", "Shift+Tab", "Escape", "ArrowDown", "Shift+ArrowDown"])(
    "browser.press %s with no ref activates nothing",
    (keys) => {
      const bank = "https://secure.chase.com";
      const run = tools(bank, {});
      expect(blocked(bank, run("browser.press", { tabId: "t", keys }))).toBe(false);
    },
  );

  it("classifyKeys reads the key after the modifiers", () => {
    const field = el("Note", { role: "textbox", inForm: true, submits: false, formMethod: "post" });
    expect(classifyKeys("Shift+Enter", undefined).sideEffect).toBe("write");
    expect(classifyKeys("Alt+Space", undefined).sideEffect).toBe("write");
    expect(classifyKeys("Shift+Enter", field).kind).toBe("browser_submit");
    expect(classifyKeys("Shift+Tab", undefined).sideEffect).toBe("read");
  });

  it("browser.type submit:true on an amount field of a POST form on a venue is refused", () => {
    const venmo = "https://venmo.com";
    const amount = el("Amount", {
      role: "textbox",
      tag: "input",
      inForm: true,
      formMethod: "post",
      formAction: "https://venmo.com/api/payments",
    });
    const run = tools(venmo, { f: amount });
    const d = run("browser.type", { tabId: "t", ref: "f", text: "500", submit: true });
    expect(d.meta?.control?.submits).toBe(true);
    expect(blocked(venmo, d)).toBe(true);
  });

  it("browser.press Enter in a field of a Chase transfer form is refused", () => {
    const bank = "https://secure.chase.com";
    const note = el("Memo", {
      role: "textbox",
      tag: "input",
      inForm: true,
      formMethod: "post",
      formAction: "https://secure.chase.com/svc/transfers/submit",
    });
    const run = tools(bank, { f: note });
    expect(blocked(bank, run("browser.press", { tabId: "t", keys: "Enter", ref: "f" }))).toBe(true);
  });

  it("Enter in a GET or script form on a venue is refused (round 2: Venmo note, Chase amount)", () => {
    const venmo = "https://account.venmo.com";
    const note = el("What's it for?", {
      role: "textbox",
      tag: "input",
      inForm: true,
      formMethod: "get",
      formAction: "https://account.venmo.com/pay",
      pageUrl: "https://account.venmo.com/pay",
    });
    const amount = el("Amount", {
      role: "textbox",
      tag: "input",
      inForm: true,
      pageUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/transfer/add",
    });
    expect(
      blocked(
        venmo,
        tools(venmo, { f: note })("browser.press", { tabId: "t", keys: "Enter", ref: "f" }),
      ),
    ).toBe(true);
    const bank = "https://secure.chase.com";
    expect(
      blocked(
        bank,
        tools(bank, { f: amount })("browser.type", {
          tabId: "t",
          ref: "f",
          text: "5",
          submit: true,
        }),
      ),
    ).toBe(true);
  });

  it("Enter in a transaction-password step-up form on a transfer page is refused (round 3)", () => {
    const sbi = "https://retail.onlinesbi.sbi";
    const pass = el("Transaction password", {
      role: "textbox",
      tag: "input",
      inForm: true,
      formMethod: "post",
      formAction: "https://retail.onlinesbi.sbi/retail/transfer/confirm",
      formHasPassword: true,
      pageUrl: "https://retail.onlinesbi.sbi/retail/transfer/confirm",
    });
    const run = tools(sbi, { f: pass });
    expect(blocked(sbi, run("browser.press", { tabId: "t", keys: "Enter", ref: "f" }))).toBe(true);
  });

  it("Enter in a field of type=search in a same-page form on a bank is not refused", () => {
    const bank = "https://www.chase.com";
    const q = el("Search", {
      role: "textbox",
      tag: "input",
      inputType: "search",
      fieldName: "q",
      inForm: true,
      pageUrl: "https://www.chase.com/personal",
      formAction: "https://www.chase.com/personal",
    });
    expect(
      blocked(
        bank,
        tools(bank, { f: q })("browser.press", { tabId: "t", keys: "Enter", ref: "f" }),
      ),
    ).toBe(false);
  });

  it("Enter in a type=search payee field inside a transfer form is refused (round 4)", () => {
    const bank = "https://secure.chase.com";
    const payee = el("Payee", {
      role: "textbox",
      tag: "input",
      inputType: "search",
      fieldName: "q",
      inForm: true,
      formMethod: "post",
      formAction: "https://secure.chase.com/svc/payments",
      pageUrl: "https://secure.chase.com/transfers/new",
    });
    const d = tools(bank, { f: payee })("browser.press", { tabId: "t", keys: "Enter", ref: "f" });
    expect(d.meta?.control?.role).toBe("textbox");
    expect(blocked(bank, d)).toBe(true);
  });

  it("Enter in a GET form that goes to another page on a venue is not refused", () => {
    const field = el("Symbol", {
      role: "textbox",
      tag: "input",
      inForm: true,
      formMethod: "get",
      formAction: "https://robinhood.com/search",
      pageUrl: "https://robinhood.com/",
    });
    const run = tools(ROBIN, { f: field });
    expect(blocked(ROBIN, run("browser.press", { tabId: "t", keys: "Enter", ref: "f" }))).toBe(
      false,
    );
  });

  it("Enter in a login form (it holds a password) on a bank is not refused", () => {
    const bank = "https://secure.chase.com";
    const user = el("Username", {
      role: "textbox",
      tag: "input",
      inForm: true,
      formMethod: "post",
      formAction: "https://secure.chase.com/auth/login",
      formHasPassword: true,
    });
    const run = tools(bank, { f: user });
    expect(blocked(bank, run("browser.press", { tabId: "t", keys: "Enter", ref: "f" }))).toBe(
      false,
    );
  });

  it("Enter in a search box (GET) on a venue is not refused", () => {
    const search = el("Search", {
      role: "searchbox",
      tag: "input",
      inForm: true,
      formMethod: "get",
      formAction: "https://robinhood.com/search",
    });
    const run = tools(ROBIN, { f: search });
    expect(blocked(ROBIN, run("browser.press", { tabId: "t", keys: "Enter", ref: "f" }))).toBe(
      false,
    );
  });

  it("an icon-only button on a venue is unreadable and refused", () => {
    const run = tools(ROBIN, { i: el("", { submits: true }) });
    expect(blocked(ROBIN, run("browser.click", { tabId: "t", target: { ref: "i" } }))).toBe(true);
  });

  it("Tab on a button named Buy activates nothing", () => {
    const run = tools(ROBIN, { b: el("Buy") });
    const d = run("browser.press", { tabId: "t", keys: "Tab", ref: "b" });
    expect(d.meta?.control).toBeUndefined();
  });

  it("accepting a page dialog on a venue reads the dialog's words", () => {
    const run = tools(ROBIN, {}, "Sell 10 shares of AAPL?");
    expect(blocked(ROBIN, run("browser.dialog", { tabId: "t", accept: true }))).toBe(true);
    const calm = tools(ROBIN, {}, "Leave this page?");
    expect(blocked(ROBIN, calm("browser.dialog", { tabId: "t", accept: true }))).toBe(false);
  });

  it("a link that goes to another page still navigates; a script link does not", () => {
    const page = `${ROBIN}/`;
    const real = el("Buy", { role: "link", href: `${ROBIN}/stocks/AAPL`, pageUrl: page });
    const script = el("Buy", { role: "link", href: "javascript:void(0)", pageUrl: page });
    const run = tools(ROBIN, { a: real, s: script });
    expect(blocked(ROBIN, run("browser.click", { tabId: "t", target: { ref: "a" } }))).toBe(false);
    expect(blocked(ROBIN, run("browser.click", { tabId: "t", target: { ref: "s" } }))).toBe(true);
  });
});

describe("browser tools: the control is read again as the click goes out", () => {
  function runTools(live: ElementMeta) {
    const calls: string[] = [];
    const driver = {
      peek: () => el("Chart"),
      tabOrigin: () => ROBIN,
      peekSnapshot: () => undefined,
      describe: async () => live,
      listTabs: async () => [{ id: "t" }],
      snapshot: async () => ({ text: "" }),
      pointer: async () => {
        calls.push("pointer");
      },
      press: async () => {
        calls.push("press");
      },
    };
    const defs = browserToolDefs({
      driver,
      broker: {},
      session: async () => "s",
    } as never) as unknown as {
      name: string;
      run: (p: unknown, c: unknown) => Promise<unknown>;
    }[];
    const run = (name: string, p: unknown) =>
      (defs.find((t) => t.name === name) as (typeof defs)[number]).run(p, {
        callId: "c1",
        signal: new AbortController().signal,
      });
    return { calls, run };
  }

  it("a button the page renamed to Buy after the describe is refused, and nothing is clicked", async () => {
    const { calls, run } = runTools(el("Buy"));
    await expect(run("browser.click", { tabId: "t", target: { ref: "r" } })).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(calls).toEqual([]);
  });

  it("a button still named Chart is clicked", async () => {
    const { calls, run } = runTools(el("Chart"));
    await run("browser.click", { tabId: "t", target: { ref: "r" } });
    expect(calls).toEqual(["pointer"]);
  });

  it("a key that activates the renamed button is refused; Tab is not checked", async () => {
    const { calls, run } = runTools(el("Buy"));
    await expect(
      run("browser.press", { tabId: "t", keys: "Alt+Space", ref: "r" }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await run("browser.press", { tabId: "t", keys: "Tab", ref: "r" });
    expect(calls).toEqual(["press"]);
  });
});
