import JSZip from "jszip";

const CT = (main: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${main}
</Types>`;

const RELS = (target: string, type: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${type}" Target="${target}"/>
</Relationships>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A minimal Word document: a heading, paragraphs and a two-row table. */
export async function sampleDocx(paragraphs: string[] = ["First paragraph.", "Second paragraph."]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
  );
  zip.file(
    "_rels/.rels",
    RELS("word/document.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"),
  );
  const p = (t: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const body = [
    p("Quarterly report", "Heading1"),
    ...paragraphs.map((t) => p(t)),
    `<w:tbl><w:tr>${cell("Region")}${cell("Total")}</w:tr><w:tr>${cell("North")}${cell("42")}</w:tr></w:tbl>`,
  ].join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

/** A PPTX-shaped package (enough for detection and the placeholder path). */
export async function samplePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    CT('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'),
  );
  zip.file(
    "_rels/.rels",
    RELS("ppt/presentation.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"),
  );
  zip.file(
    "ppt/presentation.xml",
    '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  );
  return zip.generateAsync({ type: "uint8array" });
}
