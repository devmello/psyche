import { generateKeyPairSync } from "node:crypto";
import { type ConnectParams, PROTOCOL_VERSION } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { issueChallenge, type PeerInfo } from "../src/auth.ts";
import { readServerBuild } from "../src/build-info.ts";

/** The Gateway names its build in the handshake challenge (updates design §2.10). */

const files: Record<string, string> = {
  "/bundle/build-info.json": JSON.stringify({
    version: "0.5.0",
    build: "b1b2b3",
    commit: "c0ffee",
  }),
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error("ENOENT");
  return text;
};

describe("readServerBuild", () => {
  it("reports the bundle's own build-info.json, the plist's claim separately, then dev", () => {
    expect(readServerBuild({ PSYCHE_BUILD: "from-plist" }, read).build).toBe("from-plist");
    // The file read at start is the truth about the code in memory; the plist's word is a claim.
    const both = readServerBuild(
      { PSYCHE_BUILD: "from-plist", PSYCHE_BUILD_INFO: "/bundle/build-info.json" },
      read,
    );
    expect(both).toMatchObject({ build: "b1b2b3", commit: "c0ffee", envBuild: "from-plist" });
    const same = readServerBuild(
      { PSYCHE_BUILD: "b1b2b3", PSYCHE_BUILD_INFO: "/bundle/build-info.json" },
      read,
    );
    expect(same.envBuild).toBe("b1b2b3");
    expect(readServerBuild({ PSYCHE_BUILD: "from-plist" }, read)).not.toHaveProperty("envBuild");
    expect(readServerBuild({ PSYCHE_BUILD_INFO: "/bundle/build-info.json" }, read)).toMatchObject({
      build: "b1b2b3",
      commit: "c0ffee",
    });
    expect(readServerBuild({}, read).build).toBe("dev");
  });

  it("falls back to dev for unreadable or nonsense build info, and always carries the version", () => {
    const broken = readServerBuild({ PSYCHE_BUILD_INFO: "/nowhere.json" }, read);
    expect(broken.build).toBe("dev");
    expect(broken.version).toMatch(/^\d+\.\d+\.\d+/);
    files["/bundle/odd.json"] = JSON.stringify({ build: 12 });
    expect(readServerBuild({ PSYCHE_BUILD_INFO: "/bundle/odd.json" }, read).build).toBe("dev");
    expect(readServerBuild({ PSYCHE_BUILD: "   " }, read).build).toBe("dev");
    expect(readServerBuild({ PSYCHE_BUILD: "x".repeat(200) }, read).build).toHaveLength(64);
  });
});

describe("challenge", () => {
  const peer: PeerInfo = {
    transport: "ws",
    remoteLoopback: true,
    origin: null,
    host: "127.0.0.1",
  } as PeerInfo;
  const x = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).x as string;
  const params = {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: "dev_1",
    publicKey: x,
    role: "client",
    platform: "macos",
    deviceFamily: "desktop",
    name: "Psyche",
  } as ConnectParams;

  it("carries the server build when given, and none when not (an older Gateway)", () => {
    const server = { version: "0.5.0", build: "b1b2b3" };
    const { challenge } = issueChallenge(
      params,
      peer,
      "http://127.0.0.1:7979",
      0,
      undefined,
      null,
      server,
    );
    expect(challenge.server).toEqual(server);
    const bare = issueChallenge(params, peer, "http://127.0.0.1:7979", 0).challenge;
    expect(bare).not.toHaveProperty("server");
  });
});
