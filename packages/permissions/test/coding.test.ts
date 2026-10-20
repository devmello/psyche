import { describe, expect, it } from "vitest";
import { renderForSurface } from "../src/cards.ts";
import { CTX, call, makeBroker } from "./helpers.ts";

/** The coding helper's tools (V10) under the folder policy, and the git cards. */
describe("code.* tools (V10)", () => {
  const folders = [
    { path: "/Users/o/src", mode: "rw" as const },
    { path: "/Users/o/vendor", mode: "ro" as const },
  ];
  const at = (tool: string, se: "read" | "write", p: string, extra = {}) =>
    call(tool, se, { kind: "path", value: p }, extra);

  it("judges every code.* path target by the granted folders", async () => {
    const h = makeBroker({ policy: { folders } });
    const rule = async (tool: string, se: "read" | "write", p: string) =>
      (await h.broker.decide(at(tool, se, p), CTX)).rule;
    expect(await rule("code.open", "read", "/Users/o/elsewhere")).toBe("folder:not_granted");
    // Normalized before any check; SSH keys are refused outright (#285).
    expect(await rule("code.read", "read", "/Users/o/src/app/../../.ssh/id_ed25519")).toBe(
      "prohibition:system_credentials",
    );
    // A command's cwd outside every grant is refused before any card.
    expect(await rule("code.run", "write", "/Users/o")).toBe("folder:not_granted");
    expect(await rule("code.run", "write", "/Users/o/vendor/lib")).toBe("folder:read_only");
    expect(await rule("code.edit", "write", "/Users/o/vendor/lib")).toBe("folder:read_only");
    expect(
      (await h.broker.decide(at("code.read", "read", "/Users/o/vendor/lib/a.ts"), CTX)).decision,
    ).toBe("allow");
  });

  it("floors code.edit and code.run at write and names their kinds", async () => {
    const h = makeBroker({ policy: { folders } });
    const d = await h.broker.decide(at("code.run", "read", "/Users/o/src/app"), CTX);
    expect(d.decision).not.toBe("deny");
    const edit = await h.broker.decide(at("code.edit", "none" as "read", "/Users/o/vendor"), CTX);
    expect(edit.rule).toBe("folder:read_only");
  });

  it("always asks for a push, once only, even with an allow rule and a granted folder", async () => {
    const h = makeBroker({ policy: { folders, allow: ["code.git"], defaultMode: "auto" } });
    const d = await h.broker.decide(
      at("code.git", "write", "/Users/o/src/app", { kind: "git_push" }),
      { ...CTX, permissionMode: "auto" },
    );
    expect(d).toMatchObject({ decision: "ask", rule: "git:push", scopesOffered: ["once"] });
  });

  it("renders the push card with the remote, URL, branch and commit first", () => {
    const card = renderForSurface("telegram:1", {
      id: "apr_1",
      kind: "git_push",
      summary: "Push main (0123456789ab) to origin",
      details: {
        repo: "/Users/o/src/app",
        commit: "0123456789abcdef0123456789abcdef01234567",
        branch: "fix-add",
        remoteUrl: "git@github.com:avery/app.git",
        remote: "origin",
      },
      bindingHash: "sha256:x",
      grantKey: null,
      scopesOffered: ["once"],
      deviceOnly: false,
      requiresAuthentication: false,
      taint: true,
      status: "pending",
      requestedAt: "2026-10-19T08:30:00.000Z",
      expiresAt: "2026-10-19T08:45:00.000Z",
      surfaces: ["desktop"],
      sideEffect: "write",
      requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1", toolCallId: "c1" },
    } as never);
    const lines = card.text.split("\n");
    expect(lines[0]).toBe("Push to git remote · write · after reading untrusted content");
    expect(lines.slice(1, 5)).toEqual([
      "remote: “origin”",
      "remoteUrl: “git@github.com:avery/app.git”",
      "branch: “fix-add”",
      "commit: “0123456789abcdef0123456789abcdef01234567”",
    ]);
  });
});
