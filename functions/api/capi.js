/* ============================================================
   POST /api/capi: server-side Lead to the Meta Conversions API.

   The browser sends SHA-256 hashes only (normalized client-side), plus the
   same event_id it gave the Pixel, so Meta deduplicates browser + server.
   This function validates the body, adds IP + user agent from the request,
   and forwards one Lead event. It never sees or logs raw email/phone.

   Env: META_PIXEL_ID, META_ACCESS_TOKEN, META_API_VERSION,
        META_TEST_EVENT_CODE (optional; only sent when set).
   ============================================================ */

const SERVICES = new Set(["ac_replacement", "furnace_heat_pump", "repair_maintenance"]);
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const FB_COOKIE_RE = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_.\-]{1,500}$/;
const MAX_BODY_BYTES = 4096;
const MAX_UTM_LEN = 100;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(error, status) {
  return json({ ok: false, error }, status);
}

/* Returns { value } or { error }. Only whitelisted, well-formed fields survive. */
function validate(body, siteOrigin) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  const { event_id, em, ph, service, event_source_url, fbp, fbc, utms } = body;

  if (typeof event_id !== "string" || !UUID_RE.test(event_id)) return { error: "invalid_event_id" };
  if (em != null && (typeof em !== "string" || !SHA256_RE.test(em))) return { error: "invalid_em" };
  if (ph != null && (typeof ph !== "string" || !SHA256_RE.test(ph))) return { error: "invalid_ph" };
  if (!em && !ph) return { error: "missing_user_data" };
  if (typeof service !== "string" || !SERVICES.has(service)) return { error: "invalid_service" };

  let sourceUrl;
  try {
    sourceUrl = new URL(event_source_url);
  } catch {
    return { error: "invalid_event_source_url" };
  }
  if (sourceUrl.origin !== siteOrigin || event_source_url.length > 2048) {
    return { error: "invalid_event_source_url" };
  }

  if (fbp != null && (typeof fbp !== "string" || !FB_COOKIE_RE.test(fbp))) return { error: "invalid_fbp" };
  if (fbc != null && (typeof fbc !== "string" || !FB_COOKIE_RE.test(fbc))) return { error: "invalid_fbc" };

  const cleanUtms = {};
  if (utms != null) {
    if (typeof utms !== "object" || Array.isArray(utms)) return { error: "invalid_utms" };
    for (const k of UTM_KEYS) {
      const v = utms[k];
      if (v == null || v === "") continue;
      if (typeof v !== "string" || v.length > MAX_UTM_LEN) return { error: "invalid_utms" };
      cleanUtms[k] = v;
    }
  }

  return {
    value: { event_id, em, ph, service, event_source_url, fbp, fbc, utms: cleanUtms },
  };
}

function buildEvent(v, request) {
  const user_data = {};
  if (v.em) user_data.em = [v.em];
  if (v.ph) user_data.ph = [v.ph];
  if (v.fbp) user_data.fbp = v.fbp;
  if (v.fbc) user_data.fbc = v.fbc;
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) user_data.client_ip_address = ip;
  const ua = request.headers.get("User-Agent");
  if (ua) user_data.client_user_agent = ua;

  return {
    event_name: "Lead",
    event_time: Math.floor(Date.now() / 1000),
    event_id: v.event_id,
    action_source: "website",
    event_source_url: v.event_source_url,
    user_data,
    custom_data: { content_name: v.service, ...v.utms },
  };
}

export async function onRequestPost({ request, env }) {
  const siteOrigin = new URL(request.url).origin;
  if (request.headers.get("Origin") !== siteOrigin) return fail("forbidden_origin", 403);

  if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) {
    return fail("unsupported_media_type", 415);
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return fail("payload_too_large", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return fail("payload_too_large", 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("invalid_json", 400);
  }

  const { value, error } = validate(body, siteOrigin);
  if (error) return fail(error, 400);

  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN || !env.META_API_VERSION) {
    return fail("server_misconfigured", 500);
  }

  const payload = { data: [buildEvent(value, request)], access_token: env.META_ACCESS_TOKEN };
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  // Token travels in the body, never the URL, so it can't land in access logs.
  const url = `https://graph.facebook.com/${encodeURIComponent(env.META_API_VERSION)}/${encodeURIComponent(env.META_PIXEL_ID)}/events`;

  let res;
  let meta = null;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    meta = await res.json().catch(() => null);
  } catch {
    console.log(JSON.stringify({ event_id: value.event_id, meta_status: "unreachable" }));
    return fail("meta_unreachable", 502);
  }

  // Log identifiers and status only: no hashes, IP, user agent or token.
  console.log(JSON.stringify({ event_id: value.event_id, meta_status: res.status }));

  if (!res.ok) return json({ ok: false, error: "meta_error", meta_response: meta }, 502);
  return json({ ok: true, meta_response: meta }, 200);
}
