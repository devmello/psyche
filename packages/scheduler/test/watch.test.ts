import { describe, expect, it } from "vitest";
import { parsePrice } from "../src/index.ts";
import { asleep, BASE, setup } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-19T12:00:00Z");

function watchSetup(pages: (string | Error)[]) {
  let i = 0;
  const fetched: string[] = [];
  const ctx = setup({
    start: T0,
    timers: asleep,
    watchFetch: async (url) => {
      fetched.push(url);
      const p = pages[Math.min(i, pages.length - 1)];
      i += 1;
      if (p instanceof Error) throw p;
      return { status: 200, text: p as string };
    },
  });
  return { ...ctx, fetched };
}

/** Advance one interval and run the due check. */
async function check(ctx: ReturnType<typeof watchSetup>, ms = HOUR) {
  ctx.clock.advance(ms);
  await ctx.scheduler.wake();
  await ctx.scheduler.idle();
}

describe("watches", () => {
  it("a price drop produces one alert", async () => {
    const ctx = watchSetup([
      "<span class=price>$129.00</span>",
      "<span class=price>$119.00</span>",
      "<span class=price>$89.00</span>", // crosses 100 → alert
      "<span class=price>$85.00</span>", // still below: no new alert
      "<span class=price>$89.00</span>",
      "<span class=price>$120.00</span>", // back above: re-armed
      "<span class=price>$95.00</span>", // crosses again → second alert
    ]);
    const w = await ctx.scheduler.create({
      ...BASE,
      kind: "watch",
      title: "Headphones under $100",
      schedule: "PT1H",
      prompt: "Watch the headphone price",
      watch: {
        url: "https://shop.example.com/headphones",
        check: "price_below",
        selector: "class=price>([^<]+)<",
        threshold: 100,
      },
    });
    for (let k = 0; k < 5; k += 1) await check(ctx);
    const alerts = (await ctx.notifier.list()).filter((n) => n.kind === "proactive");
    expect(alerts.map((n) => n.body)).toEqual([
      "Price 89 is at or below 100: https://shop.example.com/headphones",
    ]);
    for (let k = 0; k < 2; k += 1) await check(ctx);
    expect((await ctx.notifier.list()).filter((n) => n.kind === "proactive")).toHaveLength(2);
    const statuses = ctx.scheduler
      .runs(w.id, { limit: 10 })
      .runs.map((r) => r.status)
      .reverse();
    expect(statuses).toEqual([
      "no_reply",
      "no_reply",
      "done",
      "no_reply",
      "no_reply",
      "no_reply",
      "done",
    ]);
    // Watches never start the agent.
    expect(ctx.launcher.requests).toHaveLength(0);
  });

  it("page change: the first check is a baseline, the same change alerts once", async () => {
    const ctx = watchSetup([
      "v1 <b>open</b>",
      "v1   <b>open</b>",
      "v2 <b>sold out</b>",
      "v2 <b>sold out</b>",
    ]);
    await ctx.scheduler.create({
      ...BASE,
      kind: "watch",
      schedule: "PT1H",
      watch: { url: "https://example.com/tickets", check: "change" },
    });
    for (let k = 0; k < 4; k += 1) await check(ctx);
    expect((await ctx.notifier.list()).map((n) => n.body)).toEqual([
      "The page changed: https://example.com/tickets",
    ]);
  });

  it("text present alerts when the text appears, not while it stays", async () => {
    const ctx = watchSetup([
      "Sold out",
      "Sold out",
      "In stock now",
      "In stock now",
      "Sold out",
      "In stock now",
    ]);
    await ctx.scheduler.create({
      ...BASE,
      kind: "watch",
      schedule: "PT1H",
      watch: { url: "https://example.com/item", check: "text_present", text: "In stock" },
    });
    for (let k = 0; k < 6; k += 1) await check(ctx);
    expect(await ctx.notifier.list()).toHaveLength(2);
  });

  it("backs off exponentially on failures and resets on success", async () => {
    const ctx = watchSetup([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      "ok",
      "ok",
    ]);
    const w = await ctx.scheduler.create({
      ...BASE,
      kind: "watch",
      schedule: "PT1H",
      watch: { url: "https://example.com/flaky", check: "change" },
    });
    const gaps: number[] = [];
    let last = T0;
    for (let k = 0; k < 5; k += 1) {
      const next = Date.parse((await ctx.scheduler.get(w.id))?.nextRunAt ?? "");
      gaps.push((next - last) / HOUR);
      ctx.clock.set(next);
      last = next;
      await ctx.scheduler.wake();
      await ctx.scheduler.idle();
    }
    // 1h (first), then 2h, 4h, 8h after three failures, then back to 1h after a success.
    expect(gaps).toEqual([1, 2, 4, 8, 1]);
    const failures = ctx.db.sqlite.prepare("SELECT failures FROM watches").get() as {
      failures: number;
    };
    expect(failures.failures).toBe(0);
    expect(ctx.fetched).toHaveLength(5);
  });

  it("validates watch config", async () => {
    const { scheduler } = setup({ start: T0, timers: asleep });
    const base = { ...BASE, kind: "watch" as const, schedule: "PT1H" };
    await expect(scheduler.create(base)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      scheduler.create({ ...base, watch: { url: "file:///etc/passwd", check: "change" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      scheduler.create({ ...base, watch: { url: "https://x.example", check: "price_below" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      scheduler.create({
        ...BASE,
        kind: "cron",
        schedule: "0 * * * *",
        watch: { url: "https://x.example", check: "change" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("parses prices", () => {
    expect(parsePrice("$1,299.99")).toBe(1299.99);
    expect(parsePrice("€ 89")).toBe(89);
    expect(parsePrice("free")).toBeUndefined();
  });
});
