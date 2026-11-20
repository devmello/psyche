import { isPaymentField } from "@psyche/protocol/money-intent";

/**
 * Which form controls hold a secret the model must never read: passwords, one-time codes and
 * card details. One classifier for snapshots, page text and the screenshot guard (Claude in
 * Chrome blanks the same fields). It fails towards hiding: a hidden harmless field costs a retry,
 * a leaked secret cannot be taken back.
 */

export interface FieldFacts {
  tag: string;
  type?: string | undefined;
  autocomplete?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  /** The accessible name (label) as the AX tree gives it. */
  label?: string | undefined;
  contentEditable?: boolean | undefined;
}

const SECURE_AUTOCOMPLETE =
  /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?)$/;

/** Input types that never hold typed text, so a name such as "card" on them means nothing. */
const NON_TEXT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "hidden",
  "range",
  "color",
]);

/** Lower-case words of an identifier: splits camelCase, `_`, `-`, spaces. */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

const OTP_PHRASES = [
  /\b(otp|totp)\b/,
  /\bone time (pass)?code\b/,
  /\bone time (pin|password)\b/,
  /\b(verification|authentication|authenticator|security|confirmation|login|sms|2fa|mfa) code\b/,
  /\b(2fa|mfa|two factor|two step) (code|token|pin)\b/,
  /\b(cvc|cvv|cvv2|csc|cid)\b/,
  /\bcard (verification|security) (code|value)\b/,
  // Card numbers and expiry go through the shared `isPaymentField` rule below (it knows that a
  // library or loyalty card is not a payment card).
];

/** A field named just "password" and the like: a password shown by a reveal toggle (`type=text`). */
const PASSWORD_NAMES =
  /^(password|passwords|passwd|pwd|passcode|(current|new|old|confirm|repeat|retype|verify) (password|passwd|pwd|passcode)|(password|passwd|pwd|passcode) (again|confirmation|confirm))$/;

function matchesText(text: string | undefined): boolean {
  if (text === undefined || text === "") return false;
  const joined = words(text).join(" ");
  if (joined === "") return false;
  return PASSWORD_NAMES.test(joined) || OTP_PHRASES.some((re) => re.test(joined));
}

export function isSecureField(f: FieldFacts): boolean {
  const tag = f.tag.toUpperCase();
  const type = (f.type ?? "").toLowerCase();
  if (tag === "INPUT" && type === "password") return true;
  const ac = (f.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (ac.some((t) => SECURE_AUTOCOMPLETE.test(t))) return true;
  const textual =
    tag === "TEXTAREA" ||
    f.contentEditable === true ||
    (tag === "INPUT" && !NON_TEXT_TYPES.has(type));
  if (!textual) return false;
  if ([f.name, f.id, f.ariaLabel, f.placeholder, f.label].some(matchesText)) return true;
  return isPaymentField({
    autocomplete: f.autocomplete,
    name: f.name,
    id: f.id,
    label: f.label ?? f.ariaLabel,
    placeholder: f.placeholder,
  });
}
