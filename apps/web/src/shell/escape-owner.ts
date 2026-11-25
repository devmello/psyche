/**
 * What can own an Escape press before it means "Stop the run": an open dialog, menu, listbox
 * (the slash menu, the palette), or a popup trigger that is expanded (a dropdown, a popover).
 * Closed Radix content stays mounted with `data-state="closed"`, and hidden or inert subtrees
 * do not count. Expanded disclosures (a tool step) are not popups and are left out.
 */
const ESCAPE_OWNERS =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-haspopup][aria-expanded="true"],[role="combobox"][aria-expanded="true"]';

export function escapeHasOwner(root: ParentNode = document): boolean {
  for (const el of Array.from(root.querySelectorAll(ESCAPE_OWNERS))) {
    if (el.getAttribute("data-state") === "closed") continue;
    if (el.closest('[hidden],[aria-hidden="true"],[inert]') !== null) continue;
    return true;
  }
  return false;
}

/** An IME candidate window is open: Escape belongs to it (keyCode 229 on Safari/WebKit). */
export function isComposingKey(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229;
}
