import assert from "node:assert/strict";
import { add } from "../src/add.js";

assert.equal(add(2, 2), 4);
assert.equal(add(-1, 1), 0);
process.stdout.write("ok 2 checks\n");
