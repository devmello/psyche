import { describe, expect, it } from "vitest";
import {
  type GlassEnvironment,
  lensDisplacementMap,
  resolveGlassImpl,
  rimDisplacement,
  rimHeight,
  roundedRectSdf,
} from "../src/lib/glass.ts";

const ALL: GlassEnvironment = {
  nativeGlass: true,
  backdropUrl: true,
  backdrop: true,
  reduceTransparency: false,
  increaseContrast: false,
};

describe("resolveGlassImpl", () => {
  it("gives each surface what it asks for when the environment supports it", () => {
    for (const impl of ["native", "refraction", "css", "opaque"] as const)
      expect(resolveGlassImpl(impl, ALL)).toBe(impl);
  });

  it("walks down the ladder native → refraction → css → opaque", () => {
    expect(resolveGlassImpl("native", { ...ALL, nativeGlass: false })).toBe("refraction");
    expect(resolveGlassImpl("native", { ...ALL, nativeGlass: false, backdropUrl: false })).toBe(
      "css",
    );
    expect(resolveGlassImpl("refraction", { ...ALL, backdropUrl: false, backdrop: false })).toBe(
      "opaque",
    );
  });

  it("never climbs above the request", () => {
    expect(resolveGlassImpl("css", ALL)).toBe("css");
  });

  it("is opaque under Reduce Transparency or Increase Contrast, whatever was asked", () => {
    expect(resolveGlassImpl("native", { ...ALL, reduceTransparency: true })).toBe("opaque");
    expect(resolveGlassImpl("refraction", { ...ALL, increaseContrast: true })).toBe("opaque");
  });

  it("recedes to opaque in an inactive window (liquid-glass.md §6.2 rung 4)", () => {
    expect(resolveGlassImpl("refraction", { ...ALL, inactive: true })).toBe("opaque");
    expect(resolveGlassImpl("css", { ...ALL, inactive: false })).toBe("css");
  });
});

describe("lens geometry", () => {
  it("has a squircle rim that rises from 0 to the flat top", () => {
    expect(rimHeight(0)).toBe(0);
    expect(rimHeight(1)).toBe(1);
    expect(rimHeight(0.5)).toBeGreaterThan(0.5);
  });

  it("bends most at the edge and not at all on the flat", () => {
    expect(rimDisplacement(0.02)).toBeGreaterThan(rimDisplacement(0.5));
    expect(rimDisplacement(1)).toBe(0);
    expect(rimDisplacement(0.02)).toBeLessThanOrEqual(1);
  });

  it("measures signed distance and outward normals on a rounded rectangle", () => {
    const box = { width: 100, height: 40, radius: 20 };
    expect(roundedRectSdf(50, 20, box).distance).toBeCloseTo(-20);
    const left = roundedRectSdf(30, 20, { ...box, radius: 0 });
    expect(left.distance).toBeCloseTo(-20);
    const top = roundedRectSdf(50, 1, box);
    expect(top.ny).toBe(-1);
    expect(roundedRectSdf(99.9, 20, box).nx).toBe(1);
  });

  it("encodes no shift in the middle and an inward pull at the rim", () => {
    const w = 60;
    const h = 30;
    const map = lensDisplacementMap({ width: w, height: h, radius: 15, bezel: 8 });
    expect(map).toHaveLength(w * h * 4);
    const px = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return [map[i], map[i + 1]];
    };
    expect(px(30, 15)).toEqual([128, 128]);
    // Left rim pulls samples right (R > 128); top rim pulls them down (G > 128).
    expect(px(16, 15)[0]).toBe(128);
    expect(px(1, 15)[0]).toBeGreaterThan(128);
    expect(px(30, 1)[1]).toBeGreaterThan(128);
  });
});
