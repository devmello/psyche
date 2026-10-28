/**
 * Detects a login the owner just completed in an agent tab (security §6, §4 "Capturing a login").
 *
 * The page is read from an isolated world by main, never by a preload the page could talk to,
 * and only while the owner holds the tab: a field the agent typed is never captured. A login
 * counts as done when a password field with a typed value is followed by a top-level navigation
 * to a page that no longer shows a password field. Only top-level https frames qualify, and the
 * origin is the one the form was on (an SSO host such as `login.ucsc.edu`, not the site that
 * redirected there).
 *
 * The password lives in this object's memory until the login is reported or dropped; it is
 * never logged, never serialized and never part of an error message.
 */

export interface FormSnapshot {
  url: string;
  username: string;
  password: string;
  passwordFieldPresent: boolean;
}

export interface CapturedLogin {
  /** Origin of the page that held the form. */
  origin: string;
  username: string;
  /** Null when the owner chose "Never for this site": the sign-in is reported without a secret. */
  password: string | null;
  /** Where the tab ended up after signing in. */
  finalUrl: string;
}

export interface LoginCaptureOptions {
  /** Reads the top frame's form state; null when the page cannot be read. */
  read(): Promise<FormSnapshot | null>;
  control(): "agent" | "user" | "paused";
  isNeverSave(origin: string): boolean;
  onLogin(login: CapturedLogin): void;
  now?(): number;
  /** A form left unsubmitted this long is forgotten (default 2 minutes). */
  expireMs?: number;
}

interface Pending {
  origin: string;
  username: string;
  password: string;
  navigated: boolean;
  at: number;
}

export function httpsOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export class LoginCapture {
  #pending: Pending | null = null;
  readonly #o: LoginCaptureOptions;

  constructor(o: LoginCaptureOptions) {
    this.#o = o;
  }

  get hasPending(): boolean {
    return this.#pending !== null;
  }

  reset(): void {
    this.#pending = null;
  }

  /** The tab committed a top-level navigation. */
  navigated(url: string): void {
    const p = this.#pending;
    if (p === null) return;
    if (httpsOrigin(url) === null) this.#pending = null;
    else p.navigated = true;
  }

  /** One poll; called while the owner holds the tab. */
  async tick(): Promise<void> {
    if (this.#o.control() !== "user") {
      this.#pending = null;
      return;
    }
    const snap = await this.#o.read();
    // The agent may have taken the tab back while the page was read.
    if (this.#o.control() !== "user") {
      this.#pending = null;
      return;
    }
    if (snap === null) return;
    const origin = httpsOrigin(snap.url);
    if (origin === null) {
      this.#pending = null;
      return;
    }
    const now = this.#o.now?.() ?? Date.now();
    const p = this.#pending;
    if (p !== null && now - p.at > (this.#o.expireMs ?? 120_000)) this.#pending = null;

    if (snap.passwordFieldPresent && snap.password !== "") {
      const prev = this.#pending;
      this.#pending = {
        origin,
        username: snap.username !== "" ? snap.username : (prev?.username ?? ""),
        password: snap.password,
        navigated: false,
        at: now,
      };
      return;
    }
    const cur = this.#pending;
    if (cur === null) return;
    if (!snap.passwordFieldPresent && cur.navigated) {
      this.#pending = null;
      this.#o.onLogin({
        origin: cur.origin,
        username: cur.username,
        password: this.#o.isNeverSave(cur.origin) ? null : cur.password,
        finalUrl: snap.url,
      });
      return;
    }
    // An emptied password field on a fresh page is a failed attempt, not a login.
    if (snap.passwordFieldPresent && cur.navigated) this.#pending = null;
  }
}

/**
 * Runs in an isolated world of the top frame. Returns a JSON string so the value crosses the
 * world boundary as plain data. Picks the visible password field and the nearest visible text,
 * email or tel field before it.
 */
export const FORM_READ_SCRIPT = `(() => {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const all = Array.from(document.querySelectorAll("input"));
  const pw = all.find((e) => e.type === "password" && visible(e));
  let username = "";
  if (pw) {
    const idx = all.indexOf(pw);
    for (let i = idx - 1; i >= 0; i--) {
      const e = all[i];
      if (["text", "email", "tel", ""].includes(e.type) && visible(e) && e.value) {
        username = e.value;
        break;
      }
    }
  }
  return JSON.stringify({
    url: location.href,
    passwordFieldPresent: !!pw,
    password: pw ? pw.value : "",
    username,
  });
})()`;

export function parseFormSnapshot(raw: unknown): FormSnapshot | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<FormSnapshot>;
    if (typeof v.url !== "string") return null;
    return {
      url: v.url,
      username: typeof v.username === "string" ? v.username.slice(0, 320) : "",
      password: typeof v.password === "string" ? v.password.slice(0, 1024) : "",
      passwordFieldPresent: v.passwordFieldPresent === true,
    };
  } catch {
    return null;
  }
}
