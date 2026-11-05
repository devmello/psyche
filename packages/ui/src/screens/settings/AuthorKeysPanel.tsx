import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { SkillAuthor } from "@psyche/protocol";
import { type ReactElement, useContext, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import { presenceUnavailable } from "./SettingsApproval.tsx";
import {
  approvalIdOf,
  ErrorNotice,
  Facts,
  Group,
  hasCode,
  messageOf,
  SettingsApprovalContext,
} from "./shared.tsx";

/**
 * The owner's author key and the keys they have met (docs/design/shared-bundles-2026.md sections
 * 4, 5 and 9), in Settings → Skills → Advanced: replace the key (behind the owner's confirmation),
 * publish a signed notice, import someone's notice by file or link, and trust or revoke a key.
 * Everything that signs or loosens trust asks for the owner's confirmation first.
 */

const show = (s: string, max = 64) => sanitizeDisplay(s, max);
const MAX_NOTICE = 16 * 1024;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AuthorKeysPanel(): ReactElement {
  const call = useCall();
  const q = useGatewayQuery("skills.authors.list", {});
  const requestApproval = useContext(SettingsApprovalContext);
  const fileId = useId();
  const linkId = useId();
  const reasonId = useId();
  const hashId = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [making, setMaking] = useState(false);
  const [kind, setKind] = useState<"key" | "bundle">("key");
  const [hash, setHash] = useState("");
  const [reason, setReason] = useState("");
  const own = q.data?.own;
  const authors: readonly SkillAuthor[] = q.data?.authors ?? [];

  const fail = (what: MessageId, err: unknown) =>
    setError(
      hasCode(err, "forbidden")
        ? t("settings.connectorBundle.share.unavailable")
        : t(what, { reason: messageOf(err) }),
    );

  /** Runs a call the Gateway gates with the owner's confirmation, then again with the approval. */
  const gated = <T,>(
    key: string,
    label: string,
    run: (approvalId?: string) => Promise<T>,
    done: (r: T) => void,
    failKey: MessageId,
  ) => {
    setError(null);
    setNotice(null);
    run().then(done, (err: unknown) => {
      const approvalId = approvalIdOf(err);
      if (approvalId === null) return fail(failKey, err);
      if (requestApproval === null) return setError(presenceUnavailable());
      requestApproval({
        key,
        label,
        approvalId,
        retry: (approved) =>
          run(approved).then(
            (r) => {
              done(r);
              return r;
            },
            (retryErr: unknown) => {
              fail(failKey, retryErr);
              throw retryErr;
            },
          ),
      });
    });
  };

  const rotate = () =>
    gated(
      "skills.authors.rotate",
      t("settings.skills.keys.rotateLabel"),
      (approvalId) => call("skills.authors.rotate", approvalId === undefined ? {} : { approvalId }),
      (r) => {
        q.reload();
        setNotice(t("settings.skills.keys.rotated", { key: show(r.to.keyId, 80) }));
      },
      "settings.skills.keys.rotateFailed",
    );

  const makeNotice = () => {
    if (reason.trim() === "" || (kind === "bundle" && !KEY_ID.test(hash.trim()))) return;
    const args = {
      kind,
      reason: reason.trim(),
      ...(kind === "bundle" ? { bundleHash: hash.trim() } : {}),
    } as const;
    gated(
      "skills.authors.createNotice",
      t("settings.skills.keys.notice.label"),
      (approvalId) =>
        call(
          "skills.authors.createNotice",
          approvalId === undefined ? args : { ...args, approvalId },
        ),
      (r) => {
        download(r.filename, r.notice);
        setMaking(false);
        setNotice(t("settings.skills.keys.notice.done", { file: show(r.filename, 120) }));
      },
      "settings.skills.keys.notice.failed",
    );
  };

  type NoticeResult = Awaited<ReturnType<typeof call<"skills.authors.importNotice">>>;
  // A notice is checked first and shown ("this will revoke X"); it applies only on a second click.
  const [preview, setPreview] = useState<NoticeResult | null>(null);
  const previewNotice = (p: Promise<NoticeResult>) => {
    setError(null);
    setNotice(null);
    setPreview(null);
    p.then(setPreview, (err: unknown) => fail("settings.skills.keys.import.failed", err));
  };
  const importNotice = (p: Promise<NoticeResult>) => {
    setError(null);
    setNotice(null);
    setPreview(null);
    p.then(
      (r) => {
        q.reload();
        setNotice(
          r.kind === "key"
            ? t("settings.skills.keys.import.key", {
                key: show(r.keyId, 80),
                reason: show(r.reason, 200),
              })
            : t("settings.skills.keys.import.bundle", {
                hash: show(r.bundleHash ?? "", 80),
                reason: show(r.reason, 200),
              }),
        );
      },
      (err: unknown) => fail("settings.skills.keys.import.failed", err),
    );
  };

  const setState = (a: SkillAuthor, state: "seen" | "trusted" | "revoked") => {
    const args = { keyId: a.keyId, state };
    setError(null);
    setNotice(null);
    call("skills.authors.set", args).then(
      () => q.reload(),
      (err: unknown) => {
        const approvalId = approvalIdOf(err);
        if (approvalId === null) return fail("settings.skills.keys.import.failed", err);
        if (requestApproval === null) return setError(presenceUnavailable());
        requestApproval({
          key: "skills.authors",
          label: t("settings.skills.author.label"),
          approvalId,
          retry: (approved) =>
            call("skills.authors.set", { ...args, approvalId: approved }).then(
              (r) => {
                q.reload();
                return r;
              },
              (retryErr: unknown) => {
                fail("settings.skills.keys.import.failed", retryErr);
                throw retryErr;
              },
            ),
        });
      },
    );
  };

  return (
    <Group title={t("settings.skills.keys.title")} description={t("settings.skills.keys.hint")}>
      <div className="flex flex-col gap-4">
        <div role="status" className="text-sm empty:hidden">
          {notice ? <p>{notice}</p> : null}
        </div>
        {error ? <ErrorNotice what={error} /> : null}
        {own === undefined ? (
          <p className="text-callout text-muted-foreground">{t("settings.skills.keys.none")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <Facts
              items={[
                { term: t("settings.skills.keys.own", { name: show(own.name) }), value: null },
                {
                  term: t("settings.skills.keys.fingerprint"),
                  value: <code className="break-all">{show(own.keyId, 80)}</code>,
                },
              ]}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={rotate}>
                {t("settings.skills.keys.rotate")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMaking((v) => !v)}
              >
                {t("settings.skills.keys.notice.title")}
              </Button>
            </div>
            <p className="text-callout text-muted-foreground">
              {t("settings.skills.keys.rotateHint")}
            </p>
          </div>
        )}
        {making && own !== undefined ? (
          <form
            className="flex flex-col gap-2 rounded-md border border-gray-6 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              makeNotice();
            }}
          >
            <p className="text-callout text-muted-foreground">
              {t("settings.skills.keys.notice.hint")}
            </p>
            <fieldset className="flex flex-col gap-1">
              <legend className="font-medium">{t("settings.skills.keys.notice.kind")}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${hashId}-kind`}
                  checked={kind === "key"}
                  onChange={() => setKind("key")}
                />
                {t("settings.skills.keys.notice.kindKey")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${hashId}-kind`}
                  checked={kind === "bundle"}
                  onChange={() => setKind("bundle")}
                />
                {t("settings.skills.keys.notice.kindBundle")}
              </label>
            </fieldset>
            {kind === "bundle" ? (
              <>
                <Label htmlFor={hashId}>{t("settings.skills.keys.notice.hash")}</Label>
                <Input id={hashId} value={hash} onChange={(e) => setHash(e.target.value)} />
              </>
            ) : null}
            <Label htmlFor={reasonId}>{t("settings.skills.keys.notice.reason")}</Label>
            <Input
              id={reasonId}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={reason.trim() === "" || (kind === "bundle" && !KEY_ID.test(hash.trim()))}
              >
                {t("settings.skills.keys.notice.make")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setMaking(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        ) : null}

        {preview !== null ? (
          <section
            className="flex flex-col gap-2 rounded-md border border-approval-border p-3"
            data-testid="notice-preview"
          >
            <p role="alert" className="font-medium">
              {preview.kind === "key"
                ? t("settings.skills.keys.import.previewKey", {
                    key: show(preview.keyId, 80),
                    names:
                      preview.names.length === 0
                        ? "none"
                        : preview.names.map((n) => show(n)).join(", "),
                    reason: show(preview.reason, 200),
                  })
                : t("settings.skills.keys.import.previewBundle", {
                    hash: show(preview.bundleHash ?? "", 80),
                    reason: show(preview.reason, 200),
                  })}
            </p>
            <p className="text-callout text-muted-foreground">
              {t("settings.skills.keys.import.signedBy", { name: show(preview.signer.name) })}{" "}
              {preview.alreadyRevoked ? t("settings.skills.keys.import.already") : ""}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  importNotice(call("skills.authors.importNotice", { text: preview.text ?? "" }))
                }
              >
                {t("settings.skills.keys.import.apply")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPreview(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </section>
        ) : null}
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">{t("settings.skills.keys.import.title")}</h4>
          <p className="text-callout text-muted-foreground">
            {t("settings.skills.keys.import.hint")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={fileId}
              type="file"
              accept=".psyche-notice,application/json"
              className="sr-only"
              aria-label={t("settings.skills.keys.import.file")}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file === undefined) return;
                if (file.size > MAX_NOTICE) {
                  setError(
                    t("settings.skills.keys.import.failed", {
                      reason: t("settings.connectorBundle.import.tooBig"),
                    }),
                  );
                  return;
                }
                file.text().then(
                  (text) =>
                    previewNotice(
                      call("skills.authors.importNotice", { name: file.name, text, preview: true }),
                    ),
                  (err: unknown) => fail("settings.skills.keys.import.failed", err),
                );
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => document.getElementById(fileId)?.click()}
            >
              {t("settings.skills.keys.import.file")}
            </Button>
          </div>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim() !== "")
                previewNotice(
                  call("skills.authors.importNotice", { url: link.trim(), preview: true }),
                );
            }}
          >
            <Label htmlFor={linkId}>{t("settings.skills.keys.import.linkLabel")}</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id={linkId}
                value={link}
                placeholder={t("settings.skills.keys.import.linkPlaceholder")}
                onChange={(e) => setLink(e.target.value)}
                className="min-w-0 flex-1"
              />
              <Button type="submit" size="sm" disabled={link.trim() === ""}>
                {t("settings.skills.keys.import.go")}
              </Button>
            </div>
          </form>
        </div>

        {authors.length > 0 ? (
          <ul
            className="flex flex-col divide-y divide-gray-6"
            aria-label={t("settings.skills.keys.title")}
          >
            {authors.map((a) => (
              <li key={a.keyId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{show(a.names[0] ?? "", 64)}</span>{" "}
                  <code className="break-all text-callout text-muted-foreground">
                    {show(a.keyId, 80)}
                  </code>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-callout text-muted-foreground">
                    {t(`settings.skills.author.state.${a.state}`)}
                  </span>
                  {a.state === "trusted" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setState(a, "seen")}
                    >
                      {t("settings.skills.author.untrust")}
                    </Button>
                  ) : a.state === "seen" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setState(a, "trusted")}
                    >
                      {t("settings.skills.author.trust")}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Group>
  );
}
