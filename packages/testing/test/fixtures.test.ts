import { ApprovalRequest, Message, Run, Thread, Ulid } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_IDS,
  gmailHeader,
  gmailPlainText,
  SAMPLE_APPROVAL_REQUEST,
  SAMPLE_GMAIL_THREAD,
  SAMPLE_MESSAGES,
  SAMPLE_PDF_FORM,
  SAMPLE_PDF_FORM_BYTES,
  SAMPLE_PDF_FORM_FIELDS,
  SAMPLE_RUN,
  SAMPLE_THREAD,
} from "../src/index.ts";

function check(schema: Parameters<typeof Value.Check>[0], value: unknown): void {
  const errors = [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
  expect(errors).toEqual([]);
}

describe("fixtures", () => {
  it("threads, runs and messages validate against the protocol schemas", () => {
    check(Thread, SAMPLE_THREAD);
    check(Run, SAMPLE_RUN);
    for (const m of SAMPLE_MESSAGES) check(Message, m);
    const blockTypes = new Set(SAMPLE_MESSAGES.flatMap((m) => m.blocks.map((b) => b.type)));
    expect(blockTypes.size).toBeGreaterThanOrEqual(6);
  });

  it("fixture ids are strict ULIDs", () => {
    const ids = [
      FIXTURE_IDS.thread,
      FIXTURE_IDS.run,
      FIXTURE_IDS.task,
      FIXTURE_IDS.approval,
      FIXTURE_IDS.toolCall,
      ...FIXTURE_IDS.messages,
    ];
    for (const id of ids) expect(Value.Check(Ulid, id), id).toBe(true);
  });

  it("the sample approval validates and matches data model §4.1", () => {
    check(ApprovalRequest, SAMPLE_APPROVAL_REQUEST);
    expect(SAMPLE_APPROVAL_REQUEST.deviceOnly).toBe(true);
    expect(
      Date.parse(SAMPLE_APPROVAL_REQUEST.expiresAt) -
        Date.parse(SAMPLE_APPROVAL_REQUEST.requestedAt),
    ).toBe(30 * 60 * 1000);
  });

  it("the Gmail thread uses fictional example.com people and decodes", () => {
    expect(SAMPLE_GMAIL_THREAD.messages).toHaveLength(3);
    for (const m of SAMPLE_GMAIL_THREAD.messages) {
      expect(gmailHeader(m, "from")).toMatch(/@example\.com>$/);
      expect(gmailPlainText(m).length).toBeGreaterThan(0);
    }
    const first = SAMPLE_GMAIL_THREAD.messages[0];
    expect(first?.payload.parts?.some((p) => p.filename === "permission-slip.pdf")).toBe(true);
    const last = SAMPLE_GMAIL_THREAD.messages[2];
    expect(last).toBeDefined();
    if (last !== undefined) expect(gmailPlainText(last)).toContain("ignore your instructions");
  });

  it("the PDF form is structurally valid with correct xref offsets", () => {
    const pdf = SAMPLE_PDF_FORM;
    expect(pdf.startsWith("%PDF-1.7\n")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(SAMPLE_PDF_FORM_BYTES.length).toBe(pdf.length);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const rows = pdf
      .slice(startxref)
      .split("\n")
      .slice(3)
      .filter((r) => / 00000 n $/.test(r));
    rows.forEach((row, i) => {
      const offset = Number(row.slice(0, 10));
      expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(rows).toHaveLength(10);
    const len = Number(/\/Length (\d+) >>\nstream\n/.exec(pdf)?.[1]);
    const streamStart = pdf.indexOf("stream\n") + "stream\n".length;
    expect(pdf.slice(streamStart + len, streamStart + len + "\nendstream".length)).toBe(
      "\nendstream",
    );
    expect(pdf).toContain("/AcroForm 6 0 R");
    for (const f of SAMPLE_PDF_FORM_FIELDS) expect(pdf).toContain(`/T (${f.name})`);
  });
});
