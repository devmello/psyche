/**
 * A tiny, valid one-page PDF 1.7 with an AcroForm (three text fields and one checkbox), written
 * by hand. Byte offsets in the xref table are computed when the module loads, so the file stays
 * valid if an object is edited. `NeedAppearances true` lets viewers draw the fields.
 */

export interface PdfFormField {
  name: string;
  type: "text" | "checkbox";
  value: string;
}

export const SAMPLE_PDF_FORM_FIELDS: readonly PdfFormField[] = [
  { name: "student_name", type: "text", value: "" },
  { name: "parent_name", type: "text", value: "" },
  { name: "emergency_phone", type: "text", value: "" },
  { name: "consent", type: "checkbox", value: "Off" },
];

function textField(obj: number, name: string, rect: string): string {
  return `${obj} 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Tx /T (${name}) /V () /Rect [${rect}] /F 4 /P 3 0 R /DA (/Helv 11 Tf 0 g) /MK << /BC [0 0 0] >> >>\nendobj\n`;
}

const content = [
  "BT /F1 16 Tf 72 740 Td (Riverside Elementary - Field Trip Permission Slip) Tj ET",
  "BT /F1 11 Tf 72 700 Td (Student name:) Tj ET",
  "BT /F1 11 Tf 72 660 Td (Parent or guardian:) Tj ET",
  "BT /F1 11 Tf 72 620 Td (Emergency phone:) Tj ET",
  "BT /F1 11 Tf 100 584 Td (I consent to my child attending the trip.) Tj ET",
].join("\n");

const objects: string[] = [
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>\nendobj\n",
  "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
  "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [7 0 R 8 0 R 9 0 R 10 0 R] >>\nendobj\n",
  `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  "6 0 obj\n<< /Fields [7 0 R 8 0 R 9 0 R 10 0 R] /NeedAppearances true /DA (/Helv 11 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >>\nendobj\n",
  textField(7, "student_name", "200 692 520 712"),
  textField(8, "parent_name", "200 652 520 672"),
  textField(9, "emergency_phone", "200 612 520 632"),
  "10 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Btn /T (consent) /V /Off /AS /Off /Rect [72 580 90 598] /F 4 /P 3 0 R /MK << /BC [0 0 0] /CA (4) >> /DA (/ZaDb 12 Tf 0 g) >>\nendobj\n",
];

function build(): string {
  const header = "%PDF-1.7\n%âãÏÓ\n";
  let body = header;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefAt = Buffer.byteLength(body, "latin1");
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return body;
}

/** The PDF as a latin1 string (every char is one byte). */
export const SAMPLE_PDF_FORM: string = build();

/** The PDF bytes, e.g. to write into a fake Library or attach to a fake email. */
export const SAMPLE_PDF_FORM_BYTES: Uint8Array = new Uint8Array(
  Buffer.from(SAMPLE_PDF_FORM, "latin1"),
);
