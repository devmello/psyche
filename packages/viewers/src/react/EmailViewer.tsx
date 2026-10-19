import { useMemo, useState } from "react";
import {
  type EmailAttachment,
  type ParsedEmail,
  parseEmail,
  sanitizeEmailHtml,
} from "../core/email.ts";
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import type { ViewerProps } from "./contract.ts";
import { ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

export interface EmailViewerProps extends ViewerProps {
  /** Hosted artifact origin (see ArtifactFrame); inline srcdoc when omitted. */
  artifactHostUrl?: string;
}

/**
 * Email preview (P4): headers, attachments and the body as sanitized HTML in the artifact
 * sandbox with scripts off. Remote images stay blocked until "Load remote images". The message
 * is marked untrusted: its text is data, never instructions.
 */
export function EmailViewer(props: EmailViewerProps) {
  const state = useLoadable(props.item.id, async (signal) => parseEmail(await props.load(signal)));
  if (state.status === "loading") return <ViewerMessage kind="loading" title="Opening message…" />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This message could not be read"
        detail={state.error.message}
      />
    );
  return <Message {...props} mail={state.value} />;
}

function toDataUrl(a: EmailAttachment): string {
  let bin = "";
  for (let i = 0; i < a.content.length; i += 0x8000)
    bin += String.fromCharCode(...a.content.subarray(i, i + 0x8000));
  return `data:${a.mime};base64,${btoa(bin)}`;
}

function Message(props: EmailViewerProps & { mail: ParsedEmail }) {
  const { mail } = props;
  const [remote, setRemote] = useState(false);
  const inline = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of mail.attachments) {
      if (a.contentId !== undefined && /^image\/(png|gif|jpe?g|webp)$/.test(a.mime))
        m.set(a.contentId, toDataUrl(a));
    }
    return m;
  }, [mail]);
  const body = useMemo(
    () =>
      mail.html === undefined
        ? undefined
        : sanitizeEmailHtml(mail.html, {
            allowRemoteImages: remote,
            resolveCid: (id) => inline.get(id),
          }),
    [mail, remote, inline],
  );
  const files = mail.attachments.filter((a) => !a.inline);
  const fmt = (a: { name: string; address: string }) =>
    a.name ? `${a.name} <${a.address}>` : a.address;
  const policy = useMemo(() => ({ allowScripts: false, allowRemoteImages: remote }), [remote]);

  return (
    <article
      className="psy-email"
      data-provenance="untrusted"
      aria-label={mail.subject || "(no subject)"}
    >
      <header className="psy-email__head">
        <h2>{mail.subject || "(no subject)"}</h2>
        <dl>
          {mail.from ? (
            <>
              <dt>From</dt>
              <dd>{fmt(mail.from)}</dd>
            </>
          ) : null}
          {mail.to.length > 0 ? (
            <>
              <dt>To</dt>
              <dd>{mail.to.map(fmt).join(", ")}</dd>
            </>
          ) : null}
          {mail.cc.length > 0 ? (
            <>
              <dt>Cc</dt>
              <dd>{mail.cc.map(fmt).join(", ")}</dd>
            </>
          ) : null}
          {mail.date ? (
            <>
              <dt>Date</dt>
              <dd>{mail.date}</dd>
            </>
          ) : null}
        </dl>
        <p className="psy-email__badge">External content — treated as untrusted</p>
      </header>
      {body !== undefined && body.blockedImages > 0 && !remote ? (
        <div className="psy-email__banner" role="note">
          {body.blockedImages} remote image{body.blockedImages === 1 ? "" : "s"} blocked.{" "}
          <button type="button" onClick={() => setRemote(true)}>
            Load remote images
          </button>
        </div>
      ) : null}
      {body !== undefined ? (
        <ArtifactFrame
          title={`Message: ${mail.subject}`}
          html={body.html}
          policy={policy}
          {...(props.artifactHostUrl === undefined ? {} : { hostUrl: props.artifactHostUrl })}
          onOpenLink={(href) => props.onOpenInPane?.({ pane: "browser", target: href })}
        />
      ) : (
        <pre className="psy-email__text">{mail.text ?? ""}</pre>
      )}
      {files.length > 0 ? (
        <section aria-label="Attachments" className="psy-email__attachments">
          <h3>Attachments</h3>
          <ul>
            {files.map((a, i) => (
              <li key={`${a.filename}-${a.size}-${a.contentId ?? i}`}>
                <span>{a.filename}</span> <small>{formatSize(a.size)}</small>
                {props.onSaveToLibrary ? (
                  <button
                    type="button"
                    onClick={() =>
                      props.onSaveToLibrary?.({ name: a.filename, mime: a.mime, bytes: a.content })
                    }
                  >
                    Save to Library
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
