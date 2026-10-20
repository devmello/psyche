import { today } from "./ids.ts";

/** A small granted-folder tree for the Files pane (`files.list` / `files.read` in the mock). */

export const FILE_ROOTS = {
  documents: "/Users/you/Documents",
  project: "/Users/you/Projects/psyche",
} as const;

export type MockFileNode =
  | { kind: "folder"; modifiedAt?: string }
  | { kind: "file"; text: string; modifiedAt?: string }
  | { kind: "other" };

/** The policy folders that grant FILE_ROOTS (documents read-only, project read-write). */
export function fileRootGrants(): { path: string; mode: "ro" | "rw" }[] {
  return [
    { path: FILE_ROOTS.documents, mode: "ro" },
    { path: FILE_ROOTS.project, mode: "rw" },
  ];
}

export function fileTree(): Record<string, MockFileNode> {
  const D = FILE_ROOTS.documents;
  const P = FILE_ROOTS.project;
  return {
    [D]: { kind: "folder" },
    [`${D}/Trips`]: { kind: "folder", modifiedAt: today("08:30") },
    [`${D}/Trips/lisbon.md`]: {
      kind: "file",
      text: "# Lisbon\n\n- Flights booked\n- Find a hotel near Alfama\n",
      modifiedAt: today("08:31"),
    },
    [`${D}/permission-slip.pdf`]: {
      kind: "file",
      text: "%PDF-1.4 fixture",
      modifiedAt: "2026-10-02T15:10:00Z",
    },
    [`${D}/budget.xlsx`]: { kind: "file", text: "PK fixture sheet", modifiedAt: today("07:55") },
    [`${D}/old-link`]: { kind: "other" },
    [P]: { kind: "folder" },
    [`${P}/README.md`]: {
      kind: "file",
      text: "# Psyche\n\nAn open-source assistant.\n",
      modifiedAt: today("09:12"),
    },
    [`${P}/pitch.pptx`]: { kind: "file", text: "PK fixture deck", modifiedAt: today("09:40") },
  };
}
