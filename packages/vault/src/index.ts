/**
 * @psyche/vault — the Credential Broker (architecture §4.7; security §4; data model §6; owner S06).
 * See README.md for the public API, the threat-model checklist and what is stubbed.
 */
export {
  type CredentialFillRequest,
  credentialFillApproval,
  fillBindingInput,
} from "./approvals.ts";
export {
  bindingMatches,
  bindingProblem,
  type CredentialFillBindingInput,
  canonicalHost,
  canonicalOrigin,
  credentialFillBindingHash,
  credentialFillFields,
  credentialFillGrantKey,
  fieldClass,
  normalizeBinding,
  strictCanonicalJSON,
} from "./binding.ts";
export {
  type Argon2Params,
  base32Decode,
  base32Encode,
  DEFAULT_ARGON2,
  formatRecoveryKey,
  parseRecoveryKey,
} from "./crypto.ts";
export { reasonOf } from "./errors.ts";
export {
  checkRef,
  type OnePasswordField,
  type OnePasswordRef,
  type OnePasswordSource,
  type OpCliOptions,
  OpCliSource,
  type OpConnectOptions,
  OpConnectSource,
  type TokenProvider,
} from "./external/onepassword.ts";
export {
  assertFilled,
  type BrowserFillInput,
  type BrowserFillResult,
  type CdpSession,
  clearFocusedField,
  type FocusedElement,
  type FocusedFillOptions,
  fillBrowserField,
  fillFocused,
} from "./fill/browser.ts";
export {
  buildSecretEnv,
  type SecretEnv,
  type SecretEnvEntry,
  type SecretEnvInput,
} from "./fill/env.ts";
export {
  type AuthorizedFetchInput,
  type AuthorizedFetchResult,
  authorizedFetch,
  redactedText,
  type SafeHttpError,
  safeHttpError,
} from "./fill/http.ts";
export { createVaultHandlers, type VaultHandlers, type VaultMethodName } from "./handlers.ts";
export {
  detectFormat,
  type ImportedRow,
  type ImportFormat,
  importRows,
  parseCsv,
} from "./import.ts";
export { type MetaMirror, type SqlHandle, SqliteMetaMirror } from "./meta.ts";
export {
  type CardField,
  cardFieldAccepts,
  formatAmount,
  LINK_MAX_USD_MINOR,
  PaymentBroker,
  type PaymentBrokerOptions,
  type PurchaseInput,
  type PurchaseRequester,
  purchaseBindingHash,
  type SpendRecord,
  shred,
  spendContext,
} from "./payments/broker.ts";
export {
  type CardFile,
  type LineItem,
  type LinkCliOptions,
  LinkCliWallet,
  type LinkWallet,
  type MaskedCard,
  parseCardFile,
  parseSpendRequest,
  type ReportOutcome,
  SPEND_FINAL,
  SPEND_WAITING,
  type SpendLimits,
  type SpendRequest,
  type SpendRequestInput,
  type SpendStatus,
} from "./payments/link.ts";
export {
  base64Fragments,
  encodingsOf,
  MASK,
  type RedactorOptions,
  SecretRedactor,
} from "./redact.ts";
export {
  findRefusal,
  luhnValid,
  REFUSAL_EXPLANATION,
  type Refusal,
  type RefusalCategory,
  refusedFieldName,
  scanText,
} from "./refusals.ts";
export {
  fromB64url,
  invokeHelper,
  KEYCHAIN_ITEM_CAPABILITIES,
  KEYCHAIN_NAME_RE,
  type KeychainStatus,
  promptReason,
  toB64url,
} from "./slots/helper.ts";
export { KeychainItemStore, type KeychainItemStoreOptions } from "./slots/KeychainItems.ts";
export {
  KEYCHAIN_ACCESS_CONTROL,
  KEYCHAIN_CAPABILITIES,
  type KeychainSetParams,
  KeychainWrapper,
  type KeychainWrapperOptions,
  type VaultUnlockParams,
} from "./slots/KeychainWrapper.ts";
export { KeyFileWrapper } from "./slots/KeyFileWrapper.ts";
export type { KeyWrapper, UnwrapContext, WrapOptions, WrappedKey } from "./slots/KeyWrapper.ts";
export { type SafeStorageAdapter, SafeStorageWrapper } from "./slots/SafeStorageWrapper.ts";
export {
  type ItemAttrs,
  type ItemRow,
  type ItemSecret,
  VAULT_SCHEMA_VERSION,
  VaultStore,
} from "./store.ts";
export { parseTotpSeed, type TotpSeed, totpCode } from "./totp.ts";
export {
  type AddItemInput,
  DEFAULT_AUTO_LOCK_MINUTES,
  type ImportResult,
  type LinkOnePasswordInput,
  type UpdateItemInput,
  Vault,
  type VaultEventName,
  type VaultEvents,
  type VaultOptions,
} from "./vault.ts";
