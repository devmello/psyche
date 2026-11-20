import type { LaunchConfigReport } from "@psyche/agent-core";
import type { Notification, NotifyInput } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { CodingNoticeLimiter, codingNotices, KEEP_ACTION } from "../src/compose/coding-notices.ts";
import { NotificationActions } from "../src/compose/notification-actions.ts";

/** #1434 review r2: what the owner hears about launch config a `code.run` touched. */

const report = (over: Partial<LaunchConfigReport> = {}): LaunchConfigReport => ({
  quarantined: [],
  changed: [],
  unmoved: [],
  partial: false,
  ...over,
});

const HOUR = 3_600_000;

describe("code.run launch-config notices", () => {
  it("names what was held, with a translated one-tap Keep it", async () => {
    const sent: NotifyInput[] = [];
    const n = codingNotices((i) => sent.push(i));
    n.report(
      report({ quarantined: [".vscode", "packages/web/.npmrc"], quarantineId: "1-ab" }),
      "/Users/o/app",
    );
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "system",
      message: {
        titleKey: "notice.codeRun.held.title",
        bodyKey: "notice.codeRun.held.body",
        params: { repo: "app", paths: ".vscode, packages/web/.npmrc" },
      },
      actions: [{ id: `${KEEP_ACTION}:1-ab`, labelKey: "notice.action.keepIt" }],
      dedupeKey: "code-run-held:1-ab",
    });
  });

  it("tells about changes at most once an hour per workspace, never the same files twice in a row", () => {
    let t = 0;
    const limiter = new CodingNoticeLimiter(() => t);
    const sent: NotifyInput[] = [];
    const n = codingNotices((i) => sent.push(i), limiter);
    const idea = report({ changed: [".idea/workspace.xml"] });
    n.report(idea, "/Users/o/app");
    t = HOUR / 2;
    n.report(report({ changed: [".npmrc"] }), "/Users/o/app");
    // Another workspace has its own hour.
    n.report(idea, "/Users/o/other");
    t = 2 * HOUR;
    // The IDE rewrote the same file again: no second notice.
    n.report(idea, "/Users/o/app");
    t = 3 * HOUR;
    n.report(report({ changed: [".claude/settings.local.json"] }), "/Users/o/app");
    expect(sent.map((s) => [s.message?.params?.repo, s.message?.params?.paths])).toEqual([
      ["app", ".idea/workspace.xml"],
      ["other", ".idea/workspace.xml"],
      ["app", ".claude/settings.local.json"],
    ]);
  });

  it("says when only the top levels were checked, and when the sandbox was made again", () => {
    const sent: NotifyInput[] = [];
    const n = codingNotices((i) => sent.push(i), new CodingNoticeLimiter(() => 0));
    n.report(report({ partial: true }), "/Users/o/big");
    n.report(report({ partial: true }), "/Users/o/big");
    n.recreated("/Users/o/big");
    expect(sent.map((s) => s.message?.titleKey)).toEqual([
      "notice.codeRun.partial.title",
      "notice.codeRun.recreated.title",
    ]);
  });
});

describe("notice actions", () => {
  const n = { id: "ntf_1" } as Notification;

  it("runs the handler a prefix registered with its argument", async () => {
    const actions = new NotificationActions();
    const got: string[] = [];
    const off = actions.register("launch_config.keep", (_n, arg) => {
      got.push(arg);
    });
    await actions.run(n, "launch_config.keep:123-ab");
    await actions.run(n, "done");
    off();
    await actions.run(n, "launch_config.keep:456-cd");
    expect(got).toEqual(["123-ab"]);
    expect(() => actions.register("a:b", () => undefined)).toThrow();
  });

  it("passes a failure on, so the notice stays open", async () => {
    const actions = new NotificationActions();
    actions.register("launch_config.keep", () => {
      throw new Error("name taken");
    });
    await expect(actions.run(n, "launch_config.keep:1")).rejects.toThrow("name taken");
  });
});
