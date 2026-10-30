/* functions/api/capi.js exercised in Node with fetch stubbed: request
   validation, the exact payload sent to Meta, and PII hygiene. */
import { describe, it, assert } from "./harness.mjs";
import { createHash, randomUUID } from "node:crypto";
import { onRequestPost } from "../functions/api/capi.js";

const ORIGIN = "https://coldridge-hvac.pages.dev";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const ENV = { META_PIXEL_ID: "1234567890", META_ACCESS_TOKEN: "TEST_TOKEN_abc", META_API_VERSION: "v24.0" };

function body(over = {}) {
  return {
    event_id: randomUUID(),
    em: sha("test@example.com"),
    ph: sha("15550100123"),
    service: "ac_replacement",
    event_source_url: ORIGIN + "/?utm_source=meta",
    fbp: "fb.1.1730000000000.1234567890",
    fbc: "fb.1.1730000000000.TESTfbclid_123",
    utms: { utm_source: "meta", utm_medium: "paid_social", utm_campaign: "leads_prospecting_202611", utm_content: "acreplace_ugc01" },
    ...over,
  };
}

function req(b, headers = {}) {
  const raw = typeof b === "string" ? b : JSON.stringify(b);
  return new Request(ORIGIN + "/api/capi", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "User-Agent": "UA-test", "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: raw,
  });
}

/* Stub fetch + console.log, run the handler, return response, the Meta call and logs. */
async function call(request, env = ENV, metaStatus = 200) {
  const calls = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify(metaStatus === 200 ? { events_received: 1, fbtrace_id: "x" } : { error: { message: "bad" } }), { status: metaStatus });
  };
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const res = await onRequestPost({ request, env });
    return { res, json: await res.json(), calls, logs };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

describe("capi: request gate", () => {
  it("403 on a foreign Origin, without calling Meta", async () => {
    const r = await call(req(body(), { Origin: "https://evil.example" }));
    assert.equal(r.res.status, 403);
    assert.equal(r.calls.length, 0);
  });
  it("403 when Origin is missing", async () => {
    const request = new Request(ORIGIN + "/api/capi", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await call(request)).res.status, 403);
  });
  it("415 on non-JSON content type", async () => {
    assert.equal((await call(req(body(), { "Content-Type": "text/plain" }))).res.status, 415);
  });
  it("413 on an oversized body", async () => {
    assert.equal((await call(req(body({ pad: "x".repeat(5000) })))).res.status, 413);
  });
  it("400 on malformed JSON", async () => {
    assert.equal((await call(req("{nope"))).res.status, 400);
  });
});

describe("capi: validation", () => {
  const bad = {
    "non-UUID event_id": { event_id: "123" },
    "raw email instead of a hash": { em: "test@example.com" },
    "raw phone instead of a hash": { ph: "5550100123" },
    "no em and no ph": { em: null, ph: null },
    "unknown service": { service: "botox" },
    "cross-origin event_source_url": { event_source_url: "https://evil.example/" },
    "malformed fbc": { fbc: "not-a-cookie" },
    "oversized utm": { utms: { utm_source: "x".repeat(101) } },
  };
  for (const [name, over] of Object.entries(bad)) {
    it(`400 on ${name}`, async () => {
      const r = await call(req(body(over)));
      assert.equal(r.res.status, 400);
      assert.equal(r.json.ok, false);
      assert.equal(r.calls.length, 0);
    });
  }
  it("500 when env is incomplete", async () => {
    const r = await call(req(body()), { ...ENV, META_ACCESS_TOKEN: "" });
    assert.equal(r.res.status, 500);
    assert.equal(r.json.error, "server_misconfigured");
  });
});

describe("capi: payload to Meta", () => {
  it("sends one Lead with the browser's event_id and full user/custom data", async () => {
    const b = body();
    const r = await call(req(b));
    assert.equal(r.res.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.meta_response, { events_received: 1, fbtrace_id: "x" });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].url, "https://graph.facebook.com/v24.0/1234567890/events");
    const p = r.calls[0].payload;
    assert.equal(p.data.length, 1);
    const ev = p.data[0];
    assert.equal(ev.event_name, "Lead");
    assert.equal(ev.event_id, b.event_id);
    assert.equal(ev.action_source, "website");
    assert.equal(ev.event_source_url, b.event_source_url);
    assert.ok(Math.abs(ev.event_time - Date.now() / 1000) < 5);
    assert.deepEqual(ev.user_data, {
      em: [b.em], ph: [b.ph], fbp: b.fbp, fbc: b.fbc,
      client_ip_address: "203.0.113.7", client_user_agent: "UA-test",
    });
    assert.deepEqual(ev.custom_data, { content_name: "ac_replacement", ...b.utms });
  });
  it("test_event_code only when configured", async () => {
    assert.ok(!("test_event_code" in (await call(req(body()))).calls[0].payload));
    const r = await call(req(body()), { ...ENV, META_TEST_EVENT_CODE: "TEST123" });
    assert.equal(r.calls[0].payload.test_event_code, "TEST123");
  });
  it("token is in the body, never the URL", async () => {
    const r = await call(req(body()));
    assert.ok(!r.calls[0].url.includes(ENV.META_ACCESS_TOKEN));
    assert.equal(r.calls[0].payload.access_token, ENV.META_ACCESS_TOKEN);
  });
  it("payload contains no raw email or phone", async () => {
    const s = JSON.stringify((await call(req(body()))).calls[0].payload.data);
    assert.ok(!s.includes("@"), "raw email-like value");
    assert.ok(!/5550100123/.test(s), "raw phone");
  });
  it("502 with meta_response when Meta rejects", async () => {
    const r = await call(req(body()), ENV, 400);
    assert.equal(r.res.status, 502);
    assert.equal(r.json.error, "meta_error");
    assert.ok(r.json.meta_response.error);
  });
});

describe("capi: logging", () => {
  it("logs only event_id and status: no hashes, IP, UA or token", async () => {
    const b = body();
    const r = await call(req(b));
    const all = r.logs.join("\n");
    assert.ok(all.includes(b.event_id));
    for (const secret of [b.em, b.ph, "203.0.113.7", "UA-test", ENV.META_ACCESS_TOKEN]) {
      assert.ok(!all.includes(secret), "leaked " + secret.slice(0, 12));
    }
  });
});
