/* Static checks on the public pages, plus the client-side normalization and
   hashing helpers lifted out of app.js and run against known vectors. */
import { describe, it, assert } from "./harness.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = join(ROOT, "public");
const read = (p) => readFileSync(join(PUB, p), "utf8");
const DISCLAIMER = "Fictional demo brand for a portfolio project. Not a real business.";
const pages = ["index.html", "thank-you.html", "404.html"];

describe("pages: shared requirements", () => {
  for (const p of pages) {
    const html = read(p);
    it(`${p}: footer carries the exact disclaimer`, () => {
      const footer = html.match(/<footer[\s\S]*?<\/footer>/i)[0];
      assert.ok(footer.includes(DISCLAIMER));
    });
    it(`${p}: is noindex`, () => {
      assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    });
    it(`${p}: loads config.js then app.js, deferred`, () => {
      const c = html.indexOf('src="/config.js" defer');
      const a = html.indexOf('src="/app.js" defer');
      assert.ok(c > 0 && a > c);
    });
    it(`${p}: no testimonials, reviews or ratings`, () => {
      assert.doesNotMatch(html, /testimonial|review|rating|stars?\b|★/i);
    });
    it(`${p}: no web fonts, no raster images`, () => {
      assert.doesNotMatch(html, /fonts\.googleapis|<img\b|\.(png|jpe?g|webp|gif)\b/i);
    });
    it(`${p}: phone number lives in a single [data-dni] element`, () => {
      assert.equal((html.match(/data-dni/g) || []).length, 1);
    });
  }
});

describe("index.html: offer and form", () => {
  const html = read("index.html");
  it("has exactly one h1 and the free-estimate offer", () => {
    assert.equal((html.match(/<h1/g) || []).length, 1);
    assert.match(html, /free in-home estimate/i);
  });
  it("has services, how it works, FAQ and booking sections", () => {
    for (const id of ["services", "how", "faq", "book"]) assert.match(html, new RegExp(`id="${id}"`));
    assert.equal((html.match(/<article class="card">/g) || []).length, 3);
    assert.equal((html.match(/<ol class="steps">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length, 3);
  });
  it("form has exactly the five specified fields", () => {
    const form = html.match(/<form[\s\S]*?<\/form>/)[0];
    const names = [...form.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(names, ["name", "email", "phone", "service", "date"]);
    assert.match(form, /<form id="lead-form" novalidate>/);
  });
  it("service options match the server allowlist", () => {
    const opts = [...html.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
    const capi = readFileSync(join(ROOT, "functions/api/capi.js"), "utf8");
    for (const o of opts) assert.ok(capi.includes(`"${o}"`), `capi.js missing ${o}`);
    assert.equal(opts.length, 3);
  });
  it("has a privacy note under the form", () => {
    assert.match(html.match(/<form[\s\S]*?<\/form>/)[0], /class="privacy"/);
  });
});

describe("thank-you.html", () => {
  it("does not fire a Lead itself (only app.js PageView)", () => {
    assert.doesNotMatch(read("thank-you.html"), /fbq\(|generate_lead|lead-form/);
  });
});

describe("assets: size budget", () => {
  it("no file in public/ exceeds 100KB", () => {
    for (const f of readdirSync(PUB)) {
      assert.ok(statSync(join(PUB, f)).size < 100 * 1024, `${f} too large`);
    }
  });
  it("config.js holds no secrets", () => {
    const code = read("config.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const keys = [...code.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual(keys, ["gtmId", "pixelId"]);
    assert.doesNotMatch(code, /EAA[A-Za-z0-9]{20,}/, "looks like a Meta access token");
  });
});

/* Lift the pure helpers out of app.js (same pattern as the portfolio's funnel test). */
const app = read("app.js");
const lift = (name) => {
  const m = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(m, `${name} not found in app.js`);
  return new Function(`${m[0]}; return ${name};`)();
};
const sha = (s) => createHash("sha256").update(s).digest("hex");

describe("app.js: normalization + hashing", () => {
  const normalizeEmail = lift("normalizeEmail");
  const normalizePhone = lift("normalizePhone");
  const sha256Hex = lift("sha256Hex");

  it("email: trim + lowercase", () => {
    assert.equal(normalizeEmail("  Test.User@Example.COM "), "test.user@example.com");
  });
  it("phone: digits only, US country code added to 10 digits", () => {
    assert.equal(normalizePhone("(555) 010-0123"), "15550100123");
    assert.equal(normalizePhone("+1 555.010.0123"), "15550100123");
  });
  it("sha256Hex matches Node's SHA-256", async () => {
    assert.equal(await sha256Hex("test@example.com"), sha("test@example.com"));
    assert.match(await sha256Hex("15550100123"), /^[a-f0-9]{64}$/);
  });
});
