/** Lazy handles on the Office libraries, so the Gateway imports them without depending on each. */
export const loadXlsx = () => import("xlsx");
export const loadJszip = async () => (await import("jszip")).default;
export type XlsxWorkSheet = import("xlsx").WorkSheet;
export type XlsxCell = import("xlsx").CellObject;
