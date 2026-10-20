import { crc32, deflateRawSync } from "node:zlib";

/**
 * Small PDF, DOCX and XLSX files built in code, so the fixtures are reviewable text rather than
 * opaque binaries.
 */

const pdfString = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A PDF with one page per entry (lines of Helvetica text) and `padBytes` of unreferenced data. */
export function makePdf(pages: string[][], padBytes = 0): Buffer {
  const objs: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, i) => {
    const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${pdfString(l)}) Tj T*`).join(" ")} ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  });
  if (padBytes > 0) {
    objs.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${padBytes} >>\nstream\n`),
        Buffer.alloc(padBytes, 0x78),
        Buffer.from("\nendstream"),
      ]),
    );
  }
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let length = chunks[0]?.byteLength ?? 0;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      typeof body === "string" ? Buffer.from(body) : body,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    length += chunk.byteLength;
  });
  const xref = [
    "xref",
    `0 ${objs.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objs.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(length),
    "%%EOF",
  ].join("\n");
  chunks.push(Buffer.from(`${xref}\n`));
  return Buffer.concat(chunks);
}

/** A ZIP archive (deflated entries); `sizes` overrides the uncompressed size a header claims. */
export function makeZip(files: Record<string, string>, sizes: Record<string, number> = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const size = sizes[name] ?? data.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.byteLength, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(packed.byteLength, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.byteLength, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    central.push(cd, nameBuf);
    offset += local.byteLength + nameBuf.byteLength + packed.byteLength;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A DOCX whose body is the given raw `<w:body>` XML. */
export function makeDocx(body: string): Buffer {
  return makeZip({
    "[Content_Types].xml": "<Types/>",
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  });
}

export const para = (...runs: string[]) =>
  `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs.join("")}</w:p>`;
export const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

/** An XLSX with two sheets: Budget (shared strings, a number, a date, a boolean) and Notes. */
export function makeXlsx(): Buffer {
  return makeZip({
    "[Content_Types].xml": "<Types/>",
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns:r="${REL}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; ideas" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/sharedStrings.xml":
      "<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Re</t></r><r><t>nt</t></r></si><si><t>Due</t></si></sst>",
    "xl/styles.xml":
      '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><f>1000+200</f><v>1200</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="1"><v>46037</v></c></row><row r="5"><c r="B5" t="inlineStr"><is><t>a &lt;b&gt;</t></is></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>line one\nline two</v></c></row></sheetData></worksheet>',
  });
}
