import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";

/** Assembles a PDF from raw object bodies ("<< ... >>" or "<< ... >>\nstream...endstream"). */
export function rawPdf(objects: string[], rootObj = 1): Uint8Array {
  let body = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${rootObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

const stream = (s: string) => `<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`;

/** N text pages ("Page n of N" plus a marker word), with a two-level outline. */
export function manyPagePdf(pages = 100): Uint8Array {
  // 1 catalog, 2 pages, 3 font, 4 outlines, 5..6 outline items, then (page, content) pairs.
  const first = 7;
  const pageObj = (i: number) => first + i * 2;
  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>");
  objs.push(
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages} >>`,
  );
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objs.push("<< /Type /Outlines /First 5 0 R /Last 6 0 R /Count 2 >>");
  objs.push(`<< /Title (Introduction) /Parent 4 0 R /Next 6 0 R /Dest [${pageObj(0)} 0 R /Fit] >>`);
  objs.push(`<< /Title (Appendix) /Parent 4 0 R /Prev 5 0 R /Dest [${pageObj(pages - 1)} 0 R /Fit] >>`);
  for (let i = 0; i < pages; i++) {
    const marker = i === 41 ? "needle" : `word${i + 1}`;
    const text = `BT /F1 18 Tf 72 720 Td (Page ${i + 1} of ${pages}) Tj ET\nBT /F1 12 Tf 72 690 Td (Marker ${marker} here) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageObj(i) + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    objs.push(stream(text));
  }
  return rawPdf(objs);
}

/** A fillable AcroForm: text, multiline text, checkbox, dropdown and a read-only field. */
export async function acroFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Field trip permission slip", { x: 72, y: 720, font, size: 16 });
  const form = doc.getForm();
  const name = form.createTextField("child_name");
  name.addToPage(page, { x: 200, y: 640, width: 220, height: 20 });
  const allergies = form.createTextField("allergies");
  allergies.enableMultiline();
  allergies.addToPage(page, { x: 200, y: 560, width: 220, height: 60 });
  const consent = form.createCheckBox("consent");
  consent.addToPage(page, { x: 200, y: 520, width: 14, height: 14 });
  const grade = form.createDropdown("grade");
  grade.addOptions(["K", "1", "2", "3"]);
  grade.select("2");
  grade.addToPage(page, { x: 200, y: 480, width: 80, height: 20 });
  const school = form.createTextField("school");
  school.setText("Riverside Elementary");
  school.enableReadOnly();
  school.addToPage(page, { x: 200, y: 440, width: 220, height: 20 });
  return doc.save();
}

/** A pure-XFA form (no AcroForm fields, NeedsRendering) as produced by LiveCycle Designer. */
export function xfaPdf(): Uint8Array {
  const xdp = `<?xml version="1.0" encoding="UTF-8"?>
<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">
<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb" locale="en_US"><pageSet><pageArea name="Page1" id="Page1"><contentArea x="0.25in" y="0.25in" w="8in" h="10.5in"/><medium stock="letter" short="8.5in" long="11in"/></pageArea></pageSet>
<subform w="8in" h="10in"><field name="ChildName" w="3in" h="9mm"><ui><textEdit/></ui><font typeface="Helvetica" size="10pt"/><caption><value><text>Child name</text></value></caption></field></subform>
</subform></template>
<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><ChildName>Ada</ChildName></form1></xfa:data></xfa:datasets>
</xdp:xdp>`;
  return rawPdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R /NeedsRendering true >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Fields [] /XFA 5 0 R /DR << /Font << /Helvetica 6 0 R >> >> >>",
    stream(xdp),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}
