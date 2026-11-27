import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (de); merged into `../de.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "Läuft ab um {time}",
  "simplify.b9.execHost.sandboxed": "Läuft in der Sandbox.",
  "simplify.b9.execHost.noSandbox":
    "Die Sandbox ist nicht eingerichtet, daher kann dieser Befehl nur ohne sie laufen. Richte sie ein oder führe ihn dieses eine Mal ohne Sandbox aus.",
  "simplify.b9.execHost.noHostSandbox":
    "Auf diesem Computer gibt es keine Sandbox für Befehle, daher kann dieser Befehl nur ohne sie laufen. Du kannst ihn dieses eine Mal ausführen.",
  "simplify.b9.execHost.runOnce": "Einmal ohne Sandbox ausführen",
  "simplify.b9.library.madeBy": "Erstellt von {name}",
  "simplify.b9.library.task": "Aufgabe",
  "simplify.b9.library.more": "Mehr Filter",
};
