/** Writes styles/motion.css from src/motion/tokens.ts (docs/design/motion.md §2.4). */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { motionCss } from "../src/motion/css.ts";

const out = fileURLToPath(new URL("../src/styles/motion.css", import.meta.url));
writeFileSync(out, motionCss());
console.log(`wrote ${out}`);
