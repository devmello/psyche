import { type BrowserDriver, NotImplementedError } from "@psyche/protocol";

/**
 * Placeholder for the `BrowserDriver` implementation owned by S08.
 * Build against `FakeBrowserDriver` from `@psyche/testing` until this lands.
 */
export function createBrowserDriver(): BrowserDriver {
  throw new NotImplementedError("@psyche/browser", "createBrowserDriver");
}
