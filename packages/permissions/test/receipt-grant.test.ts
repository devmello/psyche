import { describe, expect, it } from "vitest";
import { receiptGrantId } from "../src/index.ts";

describe("receiptGrantId", () => {
  it("reads payload.grantId (the loop, coding tools) and a grant rule (connectors)", () => {
    expect(receiptGrantId({ payload: { grantId: "grt_1" } })).toBe("grt_1");
    expect(receiptGrantId({ payload: { rule: "grant:grt_2", via: "grant" } })).toBe("grt_2");
    expect(receiptGrantId({ payload: { rule: "grant:grt_2", grantId: "grt_3" } })).toBe("grt_3");
  });

  it("is undefined when the recorder cannot say", () => {
    expect(receiptGrantId({ payload: null })).toBeUndefined();
    expect(receiptGrantId({ payload: {} })).toBeUndefined();
    expect(receiptGrantId({ payload: { rule: "mode:balanced/write" } })).toBeUndefined();
    expect(receiptGrantId({ payload: { rule: "approval:apr_1" } })).toBeUndefined();
    expect(receiptGrantId({ payload: { rule: "grant:" } })).toBeUndefined();
    expect(receiptGrantId({ payload: { grantId: 7 } })).toBeUndefined();
  });
});
