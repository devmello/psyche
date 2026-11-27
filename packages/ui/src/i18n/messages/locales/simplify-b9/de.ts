import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (de); merged into `../de.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "Läuft ab um {time}",
  "simplifyB9.execHost.sandboxed": "Läuft in der Sandbox.",
  "simplifyB9.execHost.noSandbox":
    "Die Sandbox ist nicht eingerichtet, daher kann dieser Befehl nur ohne sie laufen. Richte sie ein oder führe ihn dieses eine Mal ohne Sandbox aus.",
  "simplifyB9.execHost.noHostSandbox":
    "Auf diesem Computer gibt es keine Sandbox für Befehle, daher kann dieser Befehl nur ohne sie laufen. Du kannst ihn dieses eine Mal ausführen.",
  "simplifyB9.execHost.runOnce": "Einmal ohne Sandbox ausführen",
  "simplifyB9.library.madeBy": "Erstellt von {name}",
  "simplifyB9.library.task": "Aufgabe",
  "simplifyB9.library.more": "Mehr Filter",
};
