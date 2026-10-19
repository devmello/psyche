import { describe, expect, it } from "vitest";
import {
  type ContainerBackendKind,
  execArgs,
  parseInspect,
  type RunSpec,
  removeArgs,
  runArgs,
  volumeCreateArgs,
  volumeInitArgs,
} from "../src/backends.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";

const spec: RunSpec = {
  name: "psyche-sbx-abc",
  image: "psyche-sandbox:core-dev",
  volume: "psyche-ws-abc",
  network: "none",
  limits: { ...DEFAULT_LIMITS },
  labels: { "dev.psyche.sandbox": "1" },
  env: {},
};

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("runArgs: the container contract per backend", () => {
  it.each<ContainerBackendKind>(["docker", "podman"])("%s applies every contract flag", (kind) => {
    const args = runArgs(kind, spec);
    expect(args[0]).toBe("run");
    expect(args).toContain("--read-only");
    expect(args).toContain("--init");
    expect(flagValue(args, "--network")).toBe("none");
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(flagValue(args, "--security-opt")).toBe("no-new-privileges");
    expect(flagValue(args, "--user")).toBe("1000:1000");
    expect(flagValue(args, "--memory")).toBe("512m");
    expect(flagValue(args, "--memory-swap")).toBe("512m");
    expect(flagValue(args, "--cpus")).toBe("1");
    expect(flagValue(args, "--pids-limit")).toBe("128");
    expect(flagValue(args, "--tmpfs")).toBe("/tmp:rw,nosuid,nodev,size=64m");
    expect(flagValue(args, "--mount")).toBe("type=volume,source=psyche-ws-abc,target=/workspace");
    expect(args.slice(-3)).toEqual(["psyche-sandbox:core-dev", "sleep", "infinity"]);
    // No host bind mounts, no docker socket, no privileged mode.
    expect(args.join(" ")).not.toMatch(/type=bind|docker\.sock|--privileged|-v /);
  });

  it("apple-container uses its equivalents (nproc ulimit, uid/gid flags)", () => {
    const args = runArgs("apple-container", spec);
    expect(args).toContain("--read-only");
    expect(flagValue(args, "--network")).toBe("none");
    expect(args).not.toContain("--no-dns");
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(flagValue(args, "--uid")).toBe("1000");
    expect(flagValue(args, "--gid")).toBe("1000");
    expect(flagValue(args, "--memory")).toBe("512M");
    expect(flagValue(args, "--cpus")).toBe("1");
    expect(flagValue(args, "--ulimit")).toBe("nproc=128:128");
    expect(flagValue(args, "--tmpfs")).toBe("/tmp:size=64m");
    expect(flagValue(args, "--volume")).toBe("psyche-ws-abc:/workspace");
  });

  it("apple-container drops DNS on a proxy network", () => {
    const args = runArgs("apple-container", { ...spec, network: "psyche-egress" });
    expect(flagValue(args, "--network")).toBe("psyche-egress");
    expect(args).toContain("--no-dns");
  });

  it("passes container env by name only, so values stay out of host argv", () => {
    const secretish = "http://task-token-123@192.168.97.2:3128";
    for (const kind of ["docker", "apple-container"] as const) {
      const args = runArgs(kind, { ...spec, env: { HTTP_PROXY: secretish } });
      expect(flagValue(args, "-e")).toBe("HTTP_PROXY");
      expect(args.join(" ")).not.toContain("task-token-123");
    }
  });

  it("honours custom limits", () => {
    const args = runArgs("docker", {
      ...spec,
      limits: { memoryMb: 1024, cpus: 2, pids: 256, tmpMb: 128 },
    });
    expect(flagValue(args, "--memory")).toBe("1024m");
    expect(flagValue(args, "--pids-limit")).toBe("256");
    expect(flagValue(args, "--tmpfs")).toBe("/tmp:rw,nosuid,nodev,size=128m");
  });
});

describe("other argv builders", () => {
  it("exec runs as UID 1000 in the requested cwd", () => {
    expect(execArgs("docker", "c", "/workspace/x", ["true"])).toEqual([
      "exec",
      "--interactive",
      "--user",
      "1000:1000",
      "--workdir",
      "/workspace/x",
      "c",
      "true",
    ]);
    expect(execArgs("apple-container", "c", "/workspace", ["true"])).toEqual([
      "exec",
      "--interactive",
      "--uid",
      "1000",
      "--gid",
      "1000",
      "--workdir",
      "/workspace",
      "c",
      "true",
    ]);
  });

  it("volumes: Apple gets a size and a root chown init; Docker needs neither", () => {
    expect(volumeCreateArgs("apple-container", "v", {}, "4G")).toEqual([
      "volume",
      "create",
      "-s",
      "4G",
      "v",
    ]);
    expect(volumeCreateArgs("docker", "v", { a: "1" })).toEqual([
      "volume",
      "create",
      "--label",
      "a=1",
      "v",
    ]);
    const init = volumeInitArgs("apple-container", "v", "img");
    // Absolute path: the image PATH starts with /workspace/.local/bin.
    expect(init).toContain("/usr/bin/chown");
    expect(init).not.toContain("bash");
    expect(volumeInitArgs("docker", "v", "img")).toBeNull();
  });

  it("removal differs per CLI", () => {
    expect(removeArgs("apple-container", "c")).toEqual(["delete", "--force", "c"]);
    expect(removeArgs("podman", "c")).toEqual(["rm", "--force", "c"]);
  });
});

describe("parseInspect", () => {
  it("reads Docker/Podman inspect JSON", () => {
    const json = JSON.stringify([{ State: { Running: true }, Config: { Labels: { a: "1" } } }]);
    expect(parseInspect("docker", json)).toEqual({ running: true, labels: { a: "1" } });
  });

  it("reads Apple container inspect JSON", () => {
    const json = JSON.stringify([
      { status: { state: "stopped" }, configuration: { labels: { a: "1", n: 2 } } },
    ]);
    expect(parseInspect("apple-container", json)).toEqual({ running: false, labels: { a: "1" } });
  });

  it("returns null for garbage", () => {
    expect(parseInspect("docker", "not json")).toBeNull();
    expect(parseInspect("docker", "[]")).toBeNull();
  });
});
