/* ============================================================
   Zero-dependency test harness.
   No test framework, no node_modules. Matches the project's
   hand-rolled, dependency-free philosophy. Assertions come from
   the built-in node:assert/strict module.

   Each test file imports { describe, it } from here and registers
   tests. tests/run.mjs imports every *.test.mjs file (which fills
   the registry) and then calls runAll().
   ============================================================ */
import assertStrict from "node:assert/strict";

export const assert = assertStrict;

const registry = [];
let currentSuite = "(root)";

export function describe(name, fn) {
  const prev = currentSuite;
  currentSuite = name;
  try {
    fn();
  } finally {
    currentSuite = prev;
  }
}

export function it(name, fn) {
  registry.push({ suite: currentSuite, name, fn });
}
export const test = it;

/* Lets run.mjs record a whole file failing to import as one red test. */
export function registerBrokenFile(file, err) {
  registry.push({
    suite: `LOAD ${file}`,
    name: "module import",
    fn: () => {
      throw err;
    },
  });
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function fmtErr(err) {
  const msg = (err && err.message) || String(err);
  const lines = msg.split("\n").map((l) => "      " + l);
  let out = lines.join("\n");
  if (err && err.stack) {
    const frame = err.stack
      .split("\n")
      .find((l) => l.includes(".test.mjs") || l.includes("tests"));
    if (frame) out += "\n" + DIM + "      " + frame.trim() + RESET;
  }
  return out;
}

export async function runAll() {
  const t0 = Date.now();
  const bySuite = new Map();
  for (const t of registry) {
    if (!bySuite.has(t.suite)) bySuite.set(t.suite, []);
    bySuite.get(t.suite).push(t);
  }

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const [suite, tests] of bySuite) {
    console.log("\n" + BOLD + suite + RESET);
    for (const t of tests) {
      try {
        await t.fn();
        passed++;
        console.log(`  ${GREEN}✓${RESET} ${t.name}`);
      } catch (err) {
        failed++;
        failures.push({ suite, name: t.name, err });
        console.log(`  ${RED}✗ ${t.name}${RESET}`);
        console.log(fmtErr(err));
      }
    }
  }

  const total = passed + failed;
  const secs = ((Date.now() - t0) / 1000).toFixed(2);
  console.log("\n" + "-".repeat(52));
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}PASS${RESET} ${passed}/${total} tests in ${secs}s`);
  } else {
    console.log(`${RED}${BOLD}FAIL${RESET} ${failed} failed, ${passed} passed (${total} total) in ${secs}s`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
  return { passed, failed, total };
}
