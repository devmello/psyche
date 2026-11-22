import { describe, expect, it, vi } from "vitest";

// A fake `security`: no test may show a Keychain prompt or read the real Keychain.
const calls: { file: string; args: string[] }[] = [];
vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    calls.push({ file, args });
    cb(null, "fixture-password\n");
  },
}));

import { readKeychainPassword } from "../../src/main/browser/cookie-import/read.ts";
import {
  keychainAccountOf,
  keychainServiceOf,
} from "../../src/main/browser/cookie-import/sources.ts";

describe("Keychain lookup", () => {
  it.each([
    ["chrome", "Chrome Safe Storage", "Chrome"],
    ["brave", "Brave Safe Storage", "Brave"],
    ["edge", "Microsoft Edge Safe Storage", "Microsoft Edge"],
    ["arc", "Arc Safe Storage", "Arc"],
  ] as const)(
    "%s is read by service and account, not by service alone",
    async (b, service, account) => {
      expect(keychainServiceOf(b)).toBe(service);
      expect(keychainAccountOf(b)).toBe(account);
      calls.length = 0;
      await expect(readKeychainPassword(service, account)).resolves.toBe("fixture-password");
      expect(calls).toEqual([
        {
          file: "/usr/bin/security",
          args: ["find-generic-password", "-w", "-a", account, "-s", service],
        },
      ]);
    },
  );
});
