/* Test entry point. Imports every *.test.mjs in this directory (which
   registers their tests) and runs them. A file that fails to import is
   recorded as a failing test rather than crashing the run.

   Run:  node tests/run.mjs      (Node 18+)
   or:   npm test
   ============================================================ */
import { runAll, registerBrokenFile } from "./harness.mjs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

for (const f of files) {
  try {
    await import(pathToFileURL(join(here, f)).href);
  } catch (e) {
    registerBrokenFile(f, e);
  }
}

await runAll();
