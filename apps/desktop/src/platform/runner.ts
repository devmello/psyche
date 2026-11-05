import { execFile } from "node:child_process";

/** Runs a program and reports its exit code and output; never throws. Tests pass a fake. */
export type Runner = (
  file: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
