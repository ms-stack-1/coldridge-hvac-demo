/* End-to-end check against a running `npx wrangler pages dev` (default
   http://127.0.0.1:8788). Not part of `npm test`, since it needs a browser
   and the dev server.

     BASE_URL=http://127.0.0.1:8788 node tests/e2e.cjs

   Third-party tags are stubbed: config.js is served with fake IDs and the
   GTM / Pixel script URLs return empty bodies, so fbq keeps its queue and
   we can read exactly what the page asked the Pixel to send. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8788";
const LANDING = BASE + "/?utm_source=meta&utm_medium=paid_social&utm_campaign=leads_prospecting_202611&utm_content=acreplace_ugc01&fbclid=TEST_fbclid_123";
const EMAIL = "  Test.User@Example.com ";
const PHONE = "(555) 010-0123";
const sha = (s) => createHash("sha256").update(s).digest("hex");

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log("  ✓ " + name);
}

async function newPage(browser, { hangCapi = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "_fbp", value: "fb.1.1730000000000.1234567890", url: BASE }]);
  const page = await ctx.newPage();
  await page.route("**/config.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: 'window.HVAC_CONFIG={gtmId:"GTM-TEST123",pixelId:"1234567890"};' }));
  await page.route(/googletagmanager\.com|connect\.facebook\.net/, (r) =>
    r.fulfill({ contentType: "text/javascript", body: "" }));
  /* Record what the Pixel queue and dataLayer held at the moment /api/capi
     is called; sessionStorage survives the redirect, so no race. */
  await page.addInitScript(() => {
    const realFetch = window.fetch;
    window.fetch = function (url, init) {
      if (String(url).endsWith("/api/capi")) {
        sessionStorage.setItem("__e2e_snap", JSON.stringify({
          lead: window.fbq.queue.map((a) => Array.from(a)).find((a) => a[1] === "Lead"),
          dl: window.dataLayer.find((e) => e.event === "generate_lead"),
        }));
      }
      return realFetch.apply(this, arguments);
    };
  });
  if (hangCapi) await page.route("**/api/capi", () => { /* never answer */ });
  return { ctx, page };
}

async function fill(page) {
  await page.fill("#f-name", "Test User");
  await page.fill("#f-email", EMAIL);
  await page.fill("#f-phone", PHONE);
  await page.selectOption("#f-service", "ac_replacement");
  const d = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  await page.fill("#f-date", d);
}

(async () => {
  const browser = await chromium.launch();
  try {
    const { ctx, page } = await newPage(browser);
    await page.goto(LANDING);

    await step("PageView queued on load", async () => {
      const q = await page.evaluate(() => window.fbq.queue.map((a) => Array.from(a)));
      assert.deepEqual(q.slice(0, 2), [["init", "1234567890"], ["track", "PageView"]]);
    });

    await step("first-touch UTMs + fbclid persisted in sessionStorage", async () => {
      const a = await page.evaluate(() => JSON.parse(sessionStorage.getItem("hvac_attrib")));
      assert.deepEqual(a, {
        utm_source: "meta", utm_medium: "paid_social", utm_campaign: "leads_prospecting_202611",
        utm_content: "acreplace_ugc01", fbclid: "TEST_fbclid_123",
      });
    });

    await step("_fbc cookie set as fb.1.{ms}.{fbclid}", async () => {
      const c = (await ctx.cookies()).find((x) => x.name === "_fbc");
      assert.match(decodeURIComponent(c.value), /^fb\.1\.\d{13}\.TEST_fbclid_123$/);
      const days = (c.expires - Date.now() / 1000) / 86400;
      assert.ok(days > 89 && days <= 90, "expiry ~90 days, got " + days);
    });

    await step("second landing with other UTMs does not overwrite first touch", async () => {
      await page.goto(BASE + "/?utm_source=google&utm_medium=cpc&fbclid=OTHER");
      const a = await page.evaluate(() => JSON.parse(sessionStorage.getItem("hvac_attrib")));
      assert.equal(a.utm_source, "meta");
      const c = (await ctx.cookies()).find((x) => x.name === "_fbc");
      assert.match(decodeURIComponent(c.value), /TEST_fbclid_123$/);
    });

    await step("invalid submit is blocked, fields flagged, nothing sent", async () => {
      let posted = false;
      page.on("request", (r) => { if (r.url().endsWith("/api/capi")) posted = true; });
      await page.click("button[type=submit]");
      await page.waitForTimeout(300);
      assert.equal(new URL(page.url()).pathname, "/");
      const invalid = await page.$$eval("[aria-invalid=true]", (els) => els.map((e) => e.name));
      assert.deepEqual(invalid, ["name", "email", "phone", "service", "date"]);
      assert.equal(posted, false);
    });

    let body;
    let capiStatus;
    await step("valid submit: browser Lead, dataLayer and CAPI share one event_id", async () => {
      await fill(page);
      const reqP = page.waitForRequest("**/api/capi");
      const resP = page.waitForResponse("**/api/capi");
      const t0 = Date.now();
      await page.click("button[type=submit]");
      const req = await reqP;
      body = JSON.parse(req.postData());
      capiStatus = (await resP).status();
      await page.waitForURL("**/thank-you", { timeout: 5000 });
      const elapsed = Date.now() - t0;
      const snap = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__e2e_snap")));
      assert.ok(snap, "no snapshot recorded at fetch time");
      assert.match(body.event_id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(snap.lead, ["track", "Lead", { content_name: "ac_replacement" }, { eventID: body.event_id }]);
      assert.deepEqual(snap.dl, {
        event: "generate_lead", event_id: body.event_id, service: "ac_replacement",
        utm_source: "meta", utm_medium: "paid_social", utm_campaign: "leads_prospecting_202611", utm_content: "acreplace_ugc01",
      });
      assert.ok(elapsed < 2500, "redirect took " + elapsed + "ms");
    });

    await step("CAPI request body carries hashes only (no raw PII)", async () => {
      assert.equal(body.em, sha("test.user@example.com"));
      assert.equal(body.ph, sha("15550100123"));
      assert.equal(body.fbp, "fb.1.1730000000000.1234567890");
      assert.match(body.fbc, /^fb\.1\.\d{13}\.TEST_fbclid_123$/);
      assert.deepEqual(Object.keys(body).sort(), ["em", "event_id", "event_source_url", "fbc", "fbp", "ph", "service", "utms"]);
      const raw = JSON.stringify(body);
      for (const pii of ["Test User", "example.com", "5550100123", "010-0123"]) {
        assert.ok(!raw.includes(pii), "raw PII in request: " + pii);
      }
      console.log("    (live /api/capi answered " + capiStatus + "; 502 expected when graph.facebook.com is unreachable)");
    });

    await step("thank-you page fires PageView only, no Lead", async () => {
      const q = await page.evaluate(() => window.fbq.queue.map((a) => a[1]));
      assert.deepEqual(q, ["1234567890", "PageView"]);
    });
    await ctx.close();

    await step("redirect still happens within ~1.5s when /api/capi hangs", async () => {
      const { ctx: c2, page: p2 } = await newPage(browser, { hangCapi: true });
      await p2.goto(LANDING);
      await fill(p2);
      const t0 = Date.now();
      await p2.click("button[type=submit]");
      await p2.waitForURL("**/thank-you", { timeout: 4000 });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 1400 && elapsed < 2500, "elapsed " + elapsed + "ms");
      await c2.close();
    });

    await step("server rejects a foreign Origin with 403", async () => {
      const r = await fetch(BASE + "/api/capi", {
        method: "POST",
        headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 403);
    });

    console.log("\nE2E PASS " + passed + " checks");
  } catch (e) {
    console.error("\nE2E FAIL after " + passed + " checks:\n", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
