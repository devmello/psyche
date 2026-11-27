import { describe, expect, it } from "vitest";
import { viewCommandRoute } from "../../src/shell/layout/view-command-route.ts";

describe("viewCommandRoute", () => {
  it("the main window applies to the key it shows, on a chat or another screen", () => {
    expect(viewCommandRoute({ window: "main", paneKey: "thread-1", command: "open" })).toEqual({
      applyTo: "thread-1",
      raiseMain: false,
    });
    expect(viewCommandRoute({ window: "main", paneKey: "view:home", command: "open" })).toEqual({
      applyTo: "view:home",
      raiseMain: false,
    });
  });

  it("the main window applies nothing when it has no key to show", () => {
    expect(viewCommandRoute({ window: "main", paneKey: null, command: "open" }).applyTo).toBeNull();
  });

  it("the Settings window never applies, and raises the main window only for open", () => {
    expect(
      viewCommandRoute({ window: "settings", paneKey: "view:settings", command: "open" }),
    ).toEqual({ applyTo: null, raiseMain: true });
    expect(viewCommandRoute({ window: "settings", paneKey: "thread-1", command: "close" })).toEqual(
      { applyTo: null, raiseMain: false },
    );
    expect(viewCommandRoute({ window: "settings", paneKey: null, command: "focus" })).toEqual({
      applyTo: null,
      raiseMain: false,
    });
  });

  it("pop-outs and quick entry neither apply nor raise, even for open", () => {
    for (const window of ["pop-out", "quick"] as const) {
      expect(viewCommandRoute({ window, paneKey: "thread-1", command: "open" })).toEqual({
        applyTo: null,
        raiseMain: false,
      });
    }
  });
});
