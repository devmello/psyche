import type { LaunchConfigReport } from "@psyche/agent-core";
import type { Notification, NotifyInput } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { CodingNoticeLimiter, codingNotices, KEEP_ACTION } from "../src/compose/coding-notices.ts";
import { NotificationActions } from "../src/compose/notification-actions.ts";

/** #1434 review r2: what the owner hears about launch config a `code.run` touched. */

const report = (over: Partial<LaunchConfigReport> = {}): LaunchConfigReport => ({
  quarantined: [],
  changed: [],
  fingerprints: {},
  unmoved: [],
  incidents: [],
  relinked: [],
  partial: false,
  ...over,
});

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

  /** A notifier that, like the real one, updates the open notice that has the same key. */
  const inbox = () => {
    const open = new Map<string, { id: string; input: NotifyInput }>();
    const shown: { id: string; paths: unknown }[] = [];
    let next = 1;
    const notify = async (input: NotifyInput) => {
      const key = input.dedupeKey ?? `n${next}`;
      const had = open.get(key);
      const id = had?.id ?? `ntf_${next++}`;
      open.set(key, { id, input });
      shown.push({ id, paths: input.message?.params?.paths });
      return { id };
    };
    const resolve = (key: string) => open.delete(key);
    /** `notifier.resolve(id)`: the notice with that id is closed. */
    const resolveId = (id: string) => {
      for (const [key, n] of open) if (n.id === id) open.delete(key);
    };
    return { notify, shown, resolve, resolveId };
  };

  // #1435 review r1, B1: a decoy change must not hide the real one that follows.
  it("never drops a change: one notice per workspace, updated with each new path", async () => {
    const box = inbox();
    const n = codingNotices(box.notify);
    const at = "/Users/o/app";
    await n.report(report({ changed: [".envrc"], fingerprints: { ".envrc": "file:1" } }), at);
    await n.report(
      report({
        changed: [".pre-commit-config.yaml"],
        fingerprints: { ".pre-commit-config.yaml": "file:2" },
      }),
      at,
    );
    // The same file with the same content again: nothing new to show.
    await n.report(report({ changed: [".envrc"], fingerprints: { ".envrc": "file:1" } }), at);
    // The same file changed again: shown again.
    await n.report(report({ changed: [".envrc"], fingerprints: { ".envrc": "file:3" } }), at);
    expect(box.shown).toEqual([
      { id: "ntf_1", paths: ".envrc" },
      { id: "ntf_1", paths: ".pre-commit-config.yaml, .envrc" },
      { id: "ntf_1", paths: ".envrc, .pre-commit-config.yaml" },
    ]);
  });

  // #1435 review r2, item 3: a path never listed before alerts again, not only an unread mark.
  it("alerts again with a new notice when a path it never listed appears", async () => {
    const box = inbox();
    const n = codingNotices(box.notify, { resolve: box.resolveId });
    const at = "/Users/o/app";
    await n.report(report({ changed: [".envrc"], fingerprints: { ".envrc": "file:1" } }), at);
    // The same path changed again: the open notice is updated in place.
    await n.report(report({ changed: [".envrc"], fingerprints: { ".envrc": "file:2" } }), at);
    // A new path: the old notice is closed and a new one (a new banner) lists both.
    await n.report(report({ changed: [".npmrc"], fingerprints: { ".npmrc": "file:3" } }), at);
    expect(box.shown).toEqual([
      { id: "ntf_1", paths: ".envrc" },
      { id: "ntf_1", paths: ".envrc" },
      { id: "ntf_2", paths: ".npmrc, .envrc" },
    ]);
  });

  // #1435 review r2, item 2: a move that brought in something else is held and said so.
  it("tells where something that may not be the run's is held, with Keep it", async () => {
    const sent: NotifyInput[] = [];
    const n = codingNotices((i) => sent.push(i), { quarantineDir: "/p/quarantine/code-run" });
    await n.report(
      report({ quarantined: ["sub/.vscode"], incidents: ["sub/.vscode"], quarantineId: "1-ab" }),
      "/Users/o/app",
    );
    const incident = sent.find((s) => s.message?.titleKey === "notice.codeRun.incident.title");
    expect(incident).toMatchObject({
      message: { params: { paths: "sub/.vscode", place: "/p/quarantine/code-run/1-ab" } },
      actions: [{ id: `${KEEP_ACTION}:1-ab`, labelKey: "notice.action.keepIt" }],
    });
  });

  it("starts a new change notice, with only what is new, once the owner closed the last", async () => {
    const box = inbox();
    const n = codingNotices(box.notify);
    const at = "/Users/o/app";
    await n.report(report({ changed: [".npmrc"], fingerprints: { ".npmrc": "file:1" } }), at);
    box.resolve(`code-run-changed:${at}`);
    await n.report(
      report({
        changed: [".mcp.json"],
        unmoved: ["sub/.vscode"],
        fingerprints: { ".mcp.json": "f" },
      }),
      at,
    );
    expect(box.shown.at(-1)).toEqual({ id: "ntf_2", paths: ".mcp.json, sub/.vscode" });
  });

  it("says when only the top levels were checked, and when the sandbox was made again", () => {
    const sent: NotifyInput[] = [];
    const n = codingNotices((i) => sent.push(i), { limiter: new CodingNoticeLimiter(() => 0) });
    n.report(report({ partial: true }), "/Users/o/big");
    n.report(report({ partial: true }), "/Users/o/big");
    n.recreated("/Users/o/big");
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
