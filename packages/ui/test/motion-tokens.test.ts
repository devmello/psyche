import { describe, expect, it } from "vitest";
import { motionSpring, spring, springPhysics } from "../src/motion/tokens.ts";

describe("motion tokens (docs/design/motion.md §2.3)", () => {
  it("reproduces Apple's Spring(duration: 0.5, bounce: 0.3) example", () => {
    const p = springPhysics({ duration: 0.5, bounce: 0.3 });
    expect(p.stiffness).toBeCloseTo(157.9, 1);
    expect(p.damping).toBeCloseTo(17.6, 1);
  });

  it("matches the table in motion.md", () => {
    const table = {
      micro: [987.0, 62.83, 0.167],
      snappy: [438.6, 37.7, 0.25],
      smooth: [322.3, 35.9, 0.292],
      gentle: [157.9, 25.13, 0.417],
      emphasis: [195.0, 23.74, 0.375],
      interactive: [1754.6, 72.05, 0.125],
    } as const;
    for (const [name, [k, c, vd]] of Object.entries(table)) {
      const s = spring[name as keyof typeof spring];
      expect(springPhysics(s).stiffness).toBeCloseTo(k, 0);
      expect(springPhysics(s).damping).toBeCloseTo(c, 1);
      expect(motionSpring(s).visualDuration).toBeCloseTo(vd, 2);
    }
  });

  it("keeps bounce within the chrome ceiling", () => {
    for (const s of Object.values(spring)) expect(s.bounce).toBeLessThanOrEqual(0.15);
  });
});

describe("motion CSS and literals (docs/design/motion.md §8)", () => {
  it("styles/motion.css is generated from the tokens", async () => {
    const { readFileSync } = await import("node:fs");
    const { motionCss } = await import("../src/motion/css.ts");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src/styles/motion.css"), "utf8");
    expect(css, "run `pnpm --filter @psyche/ui gen:motion`").toBe(motionCss());
  });

  it("spring curves start at 0, end at 1 and never overshoot past the bounce", async () => {
    const { springLinear } = await import("../src/motion/css.ts");
    for (const s of Object.values(spring)) {
      const stops = springLinear(s)
        .slice("linear(".length, -1)
        .split(",")
        .map((v) => Number(v.trim()));
      expect(stops[0]).toBe(0);
      expect(stops.at(-1)).toBe(1);
      expect(Math.max(...stops)).toBeLessThanOrEqual(1 + s.bounce);
    }
  });

  it("components/ui reads motion tokens instead of literals", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "src/components/ui");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/\b(duration-\d+|transition-all|cubic-bezier\()/g))
        offenders.push(`${file}: ${m[0]}`);
    }
    // drawer.tsx follows Base UI's swipe physics (its own durations); everything else uses tokens.
    expect(offenders.filter((o) => !o.startsWith("drawer.tsx"))).toEqual([]);
  });
});
