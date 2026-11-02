import type { BrowserPage } from "@psyche/search";

/**
 * Pages the browser read (`browser.read_text`), handed to whoever subscribed: today the opt-in
 * "Browser pages" search source. The hub holds nothing; with no subscriber an emit is a no-op.
 */
export class PageReadHub {
  readonly #subscribers = new Set<(page: BrowserPage) => void>();

  subscribe(fn: (page: BrowserPage) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  emit(page: BrowserPage): void {
    for (const fn of this.#subscribers) {
      try {
        fn(page);
      } catch {
        // A subscriber must not break a page read.
      }
    }
  }
}
