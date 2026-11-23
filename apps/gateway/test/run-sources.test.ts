import type { AnswerSource } from "@psyche/protocol";
import { validateWidgetSpec, type WidgetSpec } from "@psyche/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  inAppRoute,
  RUN_SOURCES_LIMIT,
  recordRunSources,
  resetRunSourcesForTests,
  runSources,
  withRunSources,
} from "../src/run-sources.ts";

const item = (id: string, route: string | null = `/library/all?item=${id}`): AnswerSource => ({
  id,
  source: "mail",
  kind: "connector",
  title: `Title ${id}`,
  date: "2026-11-20",
  route,
  provenance: "untrusted",
  span: "passage",
});

const legacySpec: WidgetSpec = {
  v: 1,
  title: "Trip",
  fallbackText: "Trip so far.",
  root: { id: "t", type: "text", text: "Ok" },
};

describe("run sources (citations for widgets and documents)", () => {
  beforeEach(() => resetRunSourcesForTests());

  it("keeps what a run's searches found, once per id, in order", () => {
    recordRunSources("run_a", [item("m1"), item("m2")]);
    recordRunSources("run_a", [item("m2"), item("m3")]);
    expect(runSources("run_a").map((s) => s.id)).toEqual(["m1", "m2", "m3"]);
    expect(runSources("run_b")).toEqual([]);
    expect(runSources(undefined)).toEqual([]);
  });

  it("never lets a run hold more than the cap", () => {
    const many = Array.from({ length: RUN_SOURCES_LIMIT + 5 }, (_, i) => item(`m${i}`));
    recordRunSources("run_big", many);
    expect(runSources("run_big")).toHaveLength(RUN_SOURCES_LIMIT);
  });

  it("keeps only in-app routes; a javascript:, URL or protocol-relative route is dropped", () => {
    expect(inAppRoute("/chat/c1?message=m1")).toBe("/chat/c1?message=m1");
    expect(inAppRoute("javascript:alert(1)")).toBeNull();
    expect(inAppRoute("https://evil.example/x")).toBeNull();
    expect(inAppRoute("//evil.example/x")).toBeNull();
    expect(inAppRoute("/ok\nevil")).toBeNull();
    expect(inAppRoute(null)).toBeNull();
    recordRunSources("run_r", [item("bad", "javascript:alert(3)")]);
    expect(runSources("run_r")[0]?.route).toBeNull();
  });

  it("a widget gets the run's sources, and any sources the model wrote itself are dropped", () => {
    recordRunSources("run_w", [item("m1")]);
    const modelSpec = {
      ...legacySpec,
      sources: [item("forged", "javascript:alert(4)")],
    };
    const attached = withRunSources(modelSpec, "run_w");
    expect(attached.sources?.map((s) => s.id)).toEqual(["m1"]);
    expect(validateWidgetSpec(attached).ok).toBe(true);
  });

  it("a widget in a run with no sources carries none, and an old spec is unchanged", () => {
    const out = withRunSources(legacySpec, "run_none");
    expect("sources" in out).toBe(false);
    expect(out).toEqual(legacySpec);
    expect(validateWidgetSpec(legacySpec).ok).toBe(true);
  });

  it("a widget spec with sources validates, and a malformed source is refused", () => {
    expect(validateWidgetSpec({ ...legacySpec, sources: [item("m1")] }).ok).toBe(true);
    const bad = validateWidgetSpec({ ...legacySpec, sources: [{ id: "m1" }] });
    expect(bad.ok).toBe(false);
  });
});
