import { generateChartSvg } from "./chart.ts";
import { generateDocx } from "./docx.ts";
import {
  type DashboardSpec,
  dashboardHtml,
  docToHtml,
  htmlFile,
  type ItinerarySpec,
  itineraryHtml,
} from "./html.ts";
import { generateMarkdown } from "./markdown.ts";
import type { ChartSpec, DeckSpec, DocSpec, GeneratedFile, WorkbookSpec } from "./model.ts";
import { generatePdf, type PdfGenOptions } from "./pdf.ts";
import { generatePptx } from "./pptx.ts";
import { generateXlsx } from "./xlsx.ts";

export * from "./chart.ts";
export * from "./docx.ts";
export * from "./html.ts";
export * from "./markdown.ts";
export * from "./model.ts";
export * from "./pdf.ts";
export * from "./pptx.ts";
export * from "./xlsx.ts";

/** What the agent's `generate_file` tool passes; one request → one or more files. */
export type GenerateRequest =
  | { format: "markdown" | "docx" | "html"; doc: DocSpec }
  | { format: "pdf"; doc: DocSpec; options?: PdfGenOptions }
  | { format: "xlsx"; workbook: WorkbookSpec }
  | { format: "pptx"; deck: DeckSpec }
  | { format: "svg"; chart: ChartSpec }
  | { format: "itinerary"; itinerary: ItinerarySpec }
  | { format: "dashboard"; dashboard: DashboardSpec };

export type GenerateFormat = GenerateRequest["format"];

/**
 * Generates files from a spec. Pure: the caller (Gateway file tool) writes them to the Library
 * through the usual `file_write` permission path and records the receipt.
 */
export async function generateFile(req: GenerateRequest): Promise<GeneratedFile[]> {
  switch (req.format) {
    case "markdown":
      return generateMarkdown(req.doc);
    case "pdf":
      return [await generatePdf(req.doc, req.options)];
    case "docx":
      return [await generateDocx(req.doc)];
    case "html":
      return [htmlFile(req.doc.title, docToHtml(req.doc))];
    case "xlsx":
      return [await generateXlsx(req.workbook)];
    case "pptx":
      return [await generatePptx(req.deck)];
    case "svg":
      return [generateChartSvg(req.chart)];
    case "itinerary":
      return [htmlFile(req.itinerary.title, itineraryHtml(req.itinerary))];
    case "dashboard":
      return [htmlFile(req.dashboard.title, dashboardHtml(req.dashboard))];
  }
}
