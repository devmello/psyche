import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Three disclosure levels (UI design §1.2 principle 3, §3.2): 0 status line only, 1 action list,
 * 2 raw tool I/O. ⌃O cycles them everywhere (§4.11).
 */
export type DisclosureLevel = 0 | 1 | 2;

export const DISCLOSURE_LABEL: Record<DisclosureLevel, string> = {
  0: "status",
  1: "actions",
  2: "raw",
};

interface DisclosureValue {
  level: DisclosureLevel;
  setLevel: (level: DisclosureLevel) => void;
  cycle: () => void;
}

const DisclosureContext = createContext<DisclosureValue>({
  level: 1,
  setLevel: () => {},
  cycle: () => {},
});

export function DisclosureProvider({
  initial = 1,
  level: controlled,
  onLevelChange,
  children,
  keyboard = true,
}: {
  initial?: DisclosureLevel;
  /** Controlled level (E11: the shell persists the transcript view mode per user). */
  level?: DisclosureLevel;
  onLevelChange?: (level: DisclosureLevel) => void;
  children?: ReactNode;
  /** Bind ⌃O on the window. */
  keyboard?: boolean;
}): ReactElement {
  const [own, setOwn] = useState<DisclosureLevel>(initial);
  const level = controlled ?? own;
  const levelRef = useRef(level);
  levelRef.current = level;
  const onChangeRef = useRef(onLevelChange);
  onChangeRef.current = onLevelChange;
  const setLevel = useCallback((next: DisclosureLevel) => {
    setOwn(next);
    onChangeRef.current?.(next);
  }, []);
  const cycle = useCallback(
    () => setLevel(((levelRef.current + 1) % 3) as DisclosureLevel),
    [setLevel],
  );
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        cycle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, cycle]);
  const value = useMemo(() => ({ level, setLevel, cycle }), [level, setLevel, cycle]);
  return <DisclosureContext.Provider value={value}>{children}</DisclosureContext.Provider>;
}

export function useDisclosure(): DisclosureValue {
  return useContext(DisclosureContext);
}

/** The cycle function, for shells that bind ⌃O themselves (AppShell does). */
export function useCycleDisclosure(): () => void {
  return useContext(DisclosureContext).cycle;
}
