import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from "@cantoo/pdf-lib";
import type { OcrProvider } from "../../src/core/extract.ts";

/**
 * Permission slip with every fillable kind: tooltip-labelled required text, max-length text,
 * radio group, list box, signature placeholder (button) and a read-only field.
 */
export async function permissionSlipPdf(opts: { xfa?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Field trip permission slip", { x: 72, y: 720, font, size: 16 });
  const form = doc.getForm();
  const parent = form.createTextField("parent_name");
  parent.enableRequired();
  parent.addToPage(page, { x: 200, y: 660, width: 220, height: 20 });
  // pdf.js reads the tooltip from the widget dictionary.
  parent.acroField
    .getWidgets()[0]
    ?.dict.set(PDFName.of("TU"), PDFString.of("Parent or guardian name"));
  const zip = form.createTextField("zip");
  zip.setMaxLength(5);
  zip.addToPage(page, { x: 200, y: 630, width: 80, height: 20 });
  const lunch = form.createRadioGroup("lunch");
  lunch.addOptionToPage("Packed", page, { x: 200, y: 600, width: 14, height: 14 });
  lunch.addOptionToPage("School", page, { x: 240, y: 600, width: 14, height: 14 });
  const days = form.createOptionList("days");
  days.addOptions(["Mon", "Tue", "Wed"]);
  days.enableMultiselect();
  days.addToPage(page, { x: 200, y: 520, width: 80, height: 60 });
  const consent = form.createCheckBox("consent");
  consent.addToPage(page, { x: 200, y: 490, width: 14, height: 14 });
  const sign = form.createButton("sign_here");
  sign.addToPage("Sign", page, { x: 200, y: 450, width: 80, height: 20 });
  const school = form.createTextField("school");
  school.setText("Riverside Elementary");
  school.enableReadOnly();
  school.addToPage(page, { x: 200, y: 420, width: 220, height: 20 });
  form.updateFieldAppearances();
  if (opts.xfa === true) {
    const xdp = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>';
    const ref = doc.context.register(doc.context.stream(xdp));
    form.acroForm.dict.set(PDFName.of("XFA"), ref);
  }
  // Saving with appearance updates would call getForm() again, which strips the XFA packet.
  return doc.save({ updateFieldAppearances: false });
}

/** A "scanned" form: labels and rules drawn as vector art, so there is no text layer. */
export async function scannedFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  for (const y of [700, 660])
    page.drawLine({ start: { x: 200, y }, end: { x: 520, y }, color: rgb(0, 0, 0) });
  return doc.save();
}

/** OCR fake: what Vision would read off `scannedFormPdf` (normalised, top-left origin). */
export function fakeOcr(): OcrProvider & { calls: number } {
  const ocr = {
    calls: 0,
    recognize: async () => {
      ocr.calls++;
      return {
        text: "Student name: ________\nDate: ______\nThank you",
        lines: [
          {
            text: "Student name: ____________",
            bbox: { x: 0.1, y: 0.1, width: 0.75, height: 0.025 },
          },
          { text: "Date:", bbox: { x: 0.1, y: 0.15, width: 0.08, height: 0.025 } },
          { text: "Thank you", bbox: { x: 0.1, y: 0.5, width: 0.2, height: 0.025 } },
        ],
      };
    },
  };
  return ocr;
}
