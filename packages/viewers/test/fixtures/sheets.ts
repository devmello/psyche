/** A finance-style CSV with quoted commas and doubled quotes. */
export function bigCsv(rows: number): string {
  const lines = ["id,date,merchant,category,amount,note"];
  const cats = ["Groceries", "Rent", "Transport", "Dining", "Utilities"];
  for (let i = 1; i <= rows; i++) {
    lines.push(
      `${i},2026-${String((i % 12) + 1).padStart(2, "0")}-15,"Store ${i % 97}, Inc.",${cats[i % 5]},${((i * 37) % 10000) / 100},"said ""hi"""`,
    );
  }
  return lines.join("\n");
}
