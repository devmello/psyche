import { useCallback, useEffect, useRef, useState } from "react";
import { useSlots } from "../slots.tsx";

/**
 * Copies text: the host's clipboard (the desktop writes through main, because the app session
 * refuses `navigator.clipboard`; #507), else `navigator.clipboard`, else a hidden textarea and
 * `execCommand("copy")`. Resolves true when one of them worked.
 */
export async function copyText(
  text: string,
  write?: (text: string) => Promise<void>,
): Promise<boolean> {
  if (write) {
    try {
      await write(text);
      return true;
    } catch {
      // Fall through to the browser's clipboard.
    }
  }
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand.
  }
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand?.("copy") === true;
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** A copy action with its outcome for two seconds: "idle" → "copied" | "failed" → "idle". */
export function useCopy(): {
  state: "idle" | "copied" | "failed";
  copy: (text: string) => Promise<boolean>;
} {
  const { writeClipboard } = useSlots();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text, writeClipboard);
      setState(ok ? "copied" : "failed");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2000);
      return ok;
    },
    [writeClipboard],
  );
  return { state, copy };
}
