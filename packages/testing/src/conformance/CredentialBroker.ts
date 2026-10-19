import { inspect } from "node:util";
import type { CredentialBroker, Target } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoSecrets, clearSecrets, registerSecret } from "../secrets.ts";
import {
  type ConformanceContext,
  type ConformanceFactory,
  expectPsycheError,
  newContext,
} from "./harness.ts";

export interface CredentialSeed {
  slug: string;
  /** Exact origin binding. */
  origin: string;
  username: string;
  password: string;
  /** An approval id the factory must treat as an approved `credential_fill` for this item. */
  approvalId: string;
}

export interface CredentialBrokerConformanceContext extends ConformanceContext {
  /** The factory must create this login item before returning. */
  seed: CredentialSeed;
}

const SEED: CredentialSeed = {
  slug: "conformance-login",
  origin: "https://login.example.com",
  username: "pat@example.com",
  password: "correct-horse-battery-staple-42",
  approvalId: "apr_conformance_fill",
};

/** Architecture §4.7, security §4.5: placeholders resolve only for executors, never leak. */
export function describeCredentialBrokerConformance(
  name: string,
  factory: ConformanceFactory<CredentialBroker, CredentialBrokerConformanceContext>,
): void {
  const setup = async () => {
    const broker = await factory({ ...newContext(), seed: { ...SEED } });
    registerSecret(SEED.password, "conformance-password");
    return broker;
  };
  const target: Target = { kind: "origin", value: SEED.origin };
  const placeholder = `{{cred:${SEED.slug}}}`;

  describe(`CredentialBroker conformance: ${name}`, () => {
    afterEach(() => clearSecrets());

    it("lists metadata without secret values", async () => {
      const broker = await setup();
      const list = await broker.list();
      const item = list.find((m) => m.slug === SEED.slug);
      expect(item).toBeDefined();
      assertNoSecrets(list, "credentials.list");
      expect((await broker.get(item?.id ?? ""))?.slug).toBe(SEED.slug);
    });

    it("resolves for a matching target with an approval, through use() only", async () => {
      const broker = await setup();
      const handle = await broker.resolve(placeholder, target, SEED.approvalId);
      expect(String(handle)).not.toContain(SEED.password);
      expect(`${handle}`).not.toContain(SEED.password);
      expect(JSON.stringify({ handle })).not.toContain(SEED.password);
      expect(inspect(handle, { showHidden: true, depth: 5 })).not.toContain(SEED.password);
      expect(JSON.stringify({ ...handle })).not.toContain(SEED.password);
      assertNoSecrets({ handle, keys: Object.keys(handle) }, "ResolvedSecret");
      expect(handle.use((v) => v === SEED.password)).toBe(true);
    });

    it("handles are one-shot", async () => {
      const broker = await setup();
      const handle = await broker.resolve(placeholder, target, SEED.approvalId);
      handle.use(() => undefined);
      expect(() => handle.use(() => undefined)).toThrow();
    });

    it("resolves a named field", async () => {
      const broker = await setup();
      const handle = await broker.resolve(
        `{{cred:${SEED.slug}.username}}`,
        target,
        SEED.approvalId,
      );
      expect(handle.use((v) => v)).toBe(SEED.username);
    });

    it("refuses a target that matches no binding, including look-alikes", async () => {
      const broker = await setup();
      for (const value of [
        "https://evil.example.com",
        `${SEED.origin}.evil.example`,
        "http://login.example.com",
      ]) {
        await expectPsycheError(
          broker.resolve(placeholder, { kind: "origin", value }, SEED.approvalId),
          "policy_denied",
        );
      }
    });

    it("refuses without an approved approval", async () => {
      const broker = await setup();
      await expectPsycheError(broker.resolve(placeholder, target, ""), "approval_required");
      await expectPsycheError(
        broker.resolve(placeholder, target, "apr_never_approved"),
        "approval_required",
      );
    });

    it("rejects malformed placeholders and unknown items", async () => {
      const broker = await setup();
      await expectPsycheError(
        broker.resolve("{{cred:Bad Slug}}", target, SEED.approvalId),
        "invalid_params",
      );
      await expectPsycheError(
        broker.resolve(SEED.password, target, SEED.approvalId),
        "invalid_params",
      );
      await expectPsycheError(
        broker.resolve("{{cred:no-such-item}}", target, SEED.approvalId),
        "not_found",
      );
    });

    it("error messages never contain the secret", async () => {
      const broker = await setup();
      const err = await broker
        .resolve(
          placeholder,
          { kind: "origin", value: "https://evil.example.com" },
          SEED.approvalId,
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      assertNoSecrets({ message: String(err), json: JSON.stringify(err) }, "resolve error");
    });

    it("redacts secret values and their encodings", async () => {
      const broker = await setup();
      const text = `pw=${SEED.password} url=${encodeURIComponent(SEED.password)} b64=${Buffer.from(SEED.password).toString("base64")}`;
      const out = broker.redact(text);
      assertNoSecrets(out, "redact output");
      expect(out).toContain("•••");
    });
  });
}
