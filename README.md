# Coldridge Heating & Air: paid-media tracking demo

> **Fictional demo brand for a portfolio project. Not a real business.**

A lead-gen landing page for a fictional HVAC contractor, built to show production-grade
paid-media measurement end to end:

- **GA4 via Google Tag Manager** (`generate_lead` with `event_id` and UTMs)
- **Meta Pixel** in the browser
- **Meta Conversions API** from a Cloudflare Pages Function, **deduplicated** with the Pixel on a shared `event_id`
- First-touch UTM and `fbclid` capture, plus a first-party `_fbc` cookie
- No raw PII leaves the browser: email and phone are normalized and SHA-256 hashed client-side

Stack: hand-written HTML/CSS/vanilla JS, one Pages Function, zero runtime dependencies,
system fonts, no images.

Roadmap: **Phase 1 (this): landing page + tracking** → Phase 2: Twilio call tracking with
dynamic number insertion (the phone number already sits in a single `[data-dni]` element) →
Phase 3: full-funnel reporting (lead → booked → sold, keyed on `event_id`).

## 1. Architecture

```
                         ┌──────────── browser ────────────┐
  ad click ──► /?utm_*&fbclid=…                            │
               │  app.js: store first-touch UTMs (sessionStorage)
               │          set _fbc = fb.1.{ms}.{fbclid}    │
               │          Pixel PageView, GTM loads        │
               │                                           │
  form submit ─┤  event_id = crypto.randomUUID()           │
               │  em/ph = sha256(normalized email/phone)   │
               ├─► fbq('track','Lead',{content_name},{eventID}) ──────────► Meta (browser)
               ├─► dataLayer.push({event:'generate_lead', event_id, …utms}) ─► GTM ─► GA4
               └─► POST /api/capi {event_id, em, ph, fbp, fbc, utms} (keepalive)
                         │
                         ▼  functions/api/capi.js (Cloudflare)
                   Origin check → validate → add IP + user agent
                         └─► graph.facebook.com/{ver}/{pixel}/events  ───► Meta (server)

  Meta sees two Lead events with the same event_name + event_id and keeps one.
  Redirect to /thank-you after the POST resolves or 1500 ms, whichever comes first.
```

Why both Pixel and CAPI: the Pixel loses events to ad blockers, ITP and closed tabs, and
CAPI recovers them server-side. Sending both without deduplication would double-count
leads and inflate reported CPL performance, so the browser generates one `event_id` and
both channels carry it.

**What leaves the browser:** hashed email and phone, service, page URL, `_fbp`, `_fbc` and
UTMs. Name and preferred date are validated and then discarded. The function logs only
`event_id` and Meta's HTTP status.

## 2. UTM taxonomy

| Param | Values | Example |
|---|---|---|
| `utm_source` | `meta` \| `google` | `meta` |
| `utm_medium` | `paid_social` \| `cpc` | `paid_social` |
| `utm_campaign` | `{objective}_{audience}_{yyyymm}` | `leads_prospecting_202611` |
| `utm_content` | `{adset}_{creative}` | `acreplace_ugc01` |
| `utm_term` | keyword (Google Search only; optional) | `ac replacement cost` |

Rules: lowercase, no spaces, underscores only. The first touch in a session wins; a
second landing in the same tab does not overwrite it.

## 3. GTM setup checklist

Use a **dedicated GTM container** for this site. Put its ID in `public/config.js`.

1. **Google tag (GA4 configuration):** your GA4 Measurement ID, trigger *Initialization – All Pages*.
2. **Data Layer Variables** (Version 2), one each, with the name equal to the key:
   `event_id`, `service`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`.
3. **Trigger:** Custom Event, event name `generate_lead`.
4. **GA4 Event tag:** event name `generate_lead`, with parameters `event_id`, `service` and
   the five `utm_*` mapped to the variables above. Use the trigger from step 3.
5. In **GA4 → Admin → Custom definitions**, register `event_id`, `service` and the UTM
   parameters as event-scoped custom dimensions, so they appear in reports.
6. In **GA4 → Admin → Events**, mark `generate_lead` as a **Key Event**.
7. Publish the container. Verify with Tag Assistant preview and **GA4 DebugView**.

The Meta Pixel is **not** deployed through GTM. `app.js` loads it directly so the browser
`eventID` can be set exactly once alongside the CAPI call.

## 4. Deploy (Cloudflare Pages)

1. Workers & Pages → Create → Pages → connect this repo.
   Framework preset: *None*. Build command: *(empty)*. **Build output directory: `public`**.
   Root directory: *(empty)*.
2. Settings → Variables and Secrets, for **Production and Preview**:
   - `META_PIXEL_ID`: numeric Pixel ID
   - `META_ACCESS_TOKEN`: CAPI token from Events Manager → Settings. **Type: Secret**
   - `META_API_VERSION`: current Graph version, e.g. `v24.0`
   - `META_TEST_EVENT_CODE`: only while testing (Events Manager → Test Events). Remove it afterwards.
3. Set `gtmId` and `pixelId` in `public/config.js` (public IDs only) and push.
4. Smoke test: `curl -i -X POST https://<your-site>.pages.dev/api/capi` must return **403**
   `forbidden_origin`. A 404/405 means the function didn't deploy; check the output
   directory setting.

## 5. Local testing

```bash
cp .dev.vars.example .dev.vars   # fill in real values; .dev.vars is gitignored
npx wrangler pages dev           # reads wrangler.toml, serves public/ + functions/ on :8788
```

```bash
npm test                                        # unit + static checks, no dependencies
BASE_URL=http://127.0.0.1:8788 node tests/e2e.cjs   # browser E2E (needs Playwright)
```

### Verifying deduplication in Meta

1. Set `META_TEST_EVENT_CODE` and redeploy (or restart `wrangler pages dev`).
2. Events Manager → Test Events → **Test browser events**, then open:
   `https://<your-site>.pages.dev/?utm_source=meta&utm_medium=paid_social&utm_campaign=leads_prospecting_202611&utm_content=acreplace_ugc01`
3. Submit the form with test details. Expect one **Lead** with both *Browser* and
   *Server* received and marked **Deduplicated**, sharing the same event ID.

## Privacy and limits

- The Origin check stops other websites from posting from a browser. It is **not**
  authentication: a script can forge `Origin`. For production, add Cloudflare Turnstile
  or rate limiting.
- No consent banner (US demo). For EU/UK traffic, gate the Pixel and GTM behind consent.
- All pages are `noindex`. The brand is fictional.
