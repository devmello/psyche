import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentGatewayTaskName,
  currentUserSid,
  GATEWAY_TASK_FOLDER,
  gatewayTaskLeaf,
  gatewayTaskName,
  LEGACY_GATEWAY_TASK,
  taskBelongsTo,
} from "../src/index.ts";

const ME = "S-1-5-21-1825757875-3616296202-2718152036-1001";
const OTHER = "S-1-5-21-1825757875-3616296202-2718152036-1002";

/** What `schtasks /Query /XML` prints for a task registered with `DESK\me` (trigger as a SID). */
const exported = (triggerSid: string, principal: string) => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><URI>\\Psyche\\Gateway</URI></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${triggerSid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${principal}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
</Task>`;

describe("the Windows Gateway task name", () => {
  it("is per account: \\Psyche\\Gateway-<SID>", () => {
    expect(GATEWAY_TASK_FOLDER).toBe("\\Psyche\\");
    expect(gatewayTaskLeaf(ME)).toBe(`Gateway-${ME}`);
    expect(gatewayTaskName(ME)).toBe(`\\Psyche\\Gateway-${ME}`);
    expect(gatewayTaskName(OTHER)).not.toBe(gatewayTaskName(ME));
    expect(LEGACY_GATEWAY_TASK).toBe("\\Psyche\\Gateway");
  });

  it("refuses anything that is not a SID (it becomes part of a task path)", () => {
    for (const bad of ["", "DESK\\me", "S-1-5-21-1\\x", "S-1-", "S-1-5-21-1 /F", "s-1-5-18x"])
      expect(() => gatewayTaskName(bad)).toThrow(/SID/);
    expect(gatewayTaskName("S-1-5-18")).toBe("\\Psyche\\Gateway-S-1-5-18");
  });

  it("matches install-local.ps1's reading of gateway-task.json", () => {
    // The PowerShell reset builds "$folder$prefix$sid" from the same file.
    const spec = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "src", "gateway-task.json"), "utf8"),
    ) as { folder: string; prefix: string; legacyName: string };
    expect(`${spec.folder}${spec.prefix}${ME}`).toBe(gatewayTaskName(ME));
    expect(`${spec.folder}${spec.legacyName}`).toBe(LEGACY_GATEWAY_TASK);
  });

  it.runIf(process.platform === "win32")("names this account's task from whoami", () => {
    const sid = currentUserSid();
    expect(sid).toMatch(/^S-1-/);
    expect(currentGatewayTaskName()).toBe(gatewayTaskName(sid as string));
  });
});

describe("taskBelongsTo (migrating the shared \\Psyche\\Gateway)", () => {
  it("is ours when the trigger's SID or the principal's DOMAIN\\user is this account", () => {
    expect(taskBelongsTo(exported(ME, "DESK\\me"), { sid: ME, userId: "DESK\\me" })).toBe(true);
    // Case differs between what was registered and what the environment says.
    expect(taskBelongsTo(exported(OTHER, "desk\\ME"), { sid: ME, userId: "DESK\\me" })).toBe(true);
    expect(taskBelongsTo(exported(ME.toLowerCase(), "x\\y"), { sid: ME })).toBe(true);
  });

  it("is another account's when neither names this one", () => {
    expect(taskBelongsTo(exported(OTHER, "DESK\\you"), { sid: ME, userId: "DESK\\me" })).toBe(
      false,
    );
    // A prefix of our name is not our name.
    expect(taskBelongsTo(exported(`${ME}0`, "DESK\\me2"), { sid: ME, userId: "DESK\\me" })).toBe(
      false,
    );
    expect(taskBelongsTo("<Task><Principals/></Task>", { sid: ME, userId: "DESK\\me" })).toBe(
      false,
    );
  });

  it("reads XML-escaped names", () => {
    expect(taskBelongsTo(exported(OTHER, "R&amp;D\\me"), { sid: ME, userId: "R&D\\me" })).toBe(
      true,
    );
  });
});
