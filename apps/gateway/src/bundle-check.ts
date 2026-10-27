import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetDir, assetPath, assetsRoot } from "@psyche/assets";
import { connectorsMigrationSql } from "@psyche/connectors";
import { openDb } from "@psyche/db";
import { documentFormatOf, extractDocument } from "@psyche/files";
import { DEFAULT_TEMPLATES_DIR } from "@psyche/memory";
import { BRIDGE_SCRIPT } from "@psyche/model-router";
import { NOTIFICATIONS_MIGRATION_URL } from "@psyche/notifications";
import { IMAGE_CONTEXT_DIR } from "@psyche/sandbox";
import { createSkillLoader } from "@psyche/skills";

/**
 * `psyched --bundle-check`: loads, from where the assets root points, every file the Gateway reads
 * next to its code, and exercises the modules that find them. The packaged app's smoke
 * (deploy/scripts/build-psyched.mjs) runs it on the bundle with a fresh temporary home; from source it
 * checks the same in a checkout. Prints one JSON object; throws on the first missing piece.
 */

/** A one-page PDF with the text "bundle check", for the extraction worker. */
function tinyPdf(): Uint8Array {
  const body = "BT /F1 18 Tf 20 100 Td (bundle check) Tj ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${body.length}>>\nstream\n${body}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`bundle check: ${what}`);
}

export async function bundleCheck(): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), "psyche-bundle-check-"));
  try {
    // Migrations apply to a fresh database, in order.
    const db = openDb(join(home, "check.db"));
    const migrations = (
      db.sqlite.prepare("SELECT count(*) AS n FROM _migrations").get() as { n: number }
    ).n;
    db.close();
    need(migrations > 0, "no migrations applied to a fresh database");

    need(connectorsMigrationSql().includes("CREATE"), "connectors migration is empty");
    need(existsSync(fileURLToPath(NOTIFICATIONS_MIGRATION_URL)), "notifications migration missing");

    const templates = readdirSync(DEFAULT_TEMPLATES_DIR).filter((f) => !f.startsWith("."));
    need(templates.length > 0, `no templates in ${DEFAULT_TEMPLATES_DIR}`);

    const loader = createSkillLoader({
      homeDir: join(home, "skills"),
      bundledDir: assetDir("skills"),
    });
    const skills = (await loader.listDetailed()).filter((s) => s.source === "bundled");
    need(skills.length > 0, "no bundled skills");
    const bad = skills.filter((s) => ["invalid", "blocked", "hash_mismatch"].includes(s.status));
    need(bad.length === 0, `skills that do not load: ${bad.map((s) => s.name).join(", ")}`);

    const web = assetPath("apps/web/dist/index.html");
    need(statSync(web).isFile() && readFileSync(web, "utf8").includes("<"), "web client missing");
    need(existsSync(join(IMAGE_CONTEXT_DIR, "Dockerfile")), "sandbox image context missing");
    need(existsSync(BRIDGE_SCRIPT), "MCP stdio bridge missing");

    // The extraction worker is its own entry in the bundle: a real PDF goes through it.
    need(documentFormatOf("a.pdf") === "pdf", "pdf format");
    const page = await extractDocument("pdf", tinyPdf(), { offset: 0, timeoutMs: 20_000 });
    need(page.text.includes("bundle check"), "the extraction worker returned no text");

    return {
      root: assetsRoot(),
      migrations,
      templates: templates.length,
      skills: skills.length,
      pdfText: page.text.trim(),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
