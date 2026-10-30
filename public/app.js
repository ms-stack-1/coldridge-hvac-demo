/* ============================================================
   Coldridge Heating & Air: attribution, tags, and lead form.

   Flow on a valid submit:
     event_id (UUID) -> hash email/phone in the browser
     -> Pixel Lead {eventID}          (browser)
     -> dataLayer generate_lead       (GTM -> GA4)
     -> POST /api/capi                (server -> Meta CAPI, same event_id)
     -> redirect after POST or 1500ms, whichever comes first.
   Meta deduplicates the browser and server Lead on event_id.
   Raw form values never leave the page.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.HVAC_CONFIG || {};
  var ATTRIB_KEY = "hvac_attrib";
  var ATTRIB_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
  var UTM_KEYS = ATTRIB_PARAMS.slice(0, 5);
  var SERVICES = ["ac_replacement", "furnace_heat_pump", "repair_maintenance"];
  var REDIRECT_URL = "/thank-you";
  var REDIRECT_TIMEOUT_MS = 1500;
  var FBC_MAX_AGE_S = 90 * 24 * 60 * 60;

  window.dataLayer = window.dataLayer || [];

  /* ---------- attribution (first touch wins) ---------- */

  function readAttribution() {
    try {
      return JSON.parse(sessionStorage.getItem(ATTRIB_KEY) || "null") || {};
    } catch (e) {
      return {};
    }
  }

  function captureAttribution() {
    var params = new URLSearchParams(location.search);
    var found = {};
    var any = false;
    ATTRIB_PARAMS.forEach(function (k) {
      var v = params.get(k);
      if (v) {
        found[k] = v.slice(0, 500);
        any = true;
      }
    });
    if (!any) return;
    try {
      if (!sessionStorage.getItem(ATTRIB_KEY)) {
        sessionStorage.setItem(ATTRIB_KEY, JSON.stringify(found));
      }
    } catch (e) { /* storage blocked: attribution is best effort */ }
  }

  /* ---------- cookies ---------- */

  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* _fbc from the landing fbclid, set before the Pixel boots so both the
     Pixel and CAPI report the same click ID. Host-only: pages.dev is a
     public suffix, so a Domain attribute would be rejected. */
  function ensureFbc() {
    var fbclid = new URLSearchParams(location.search).get("fbclid");
    if (!fbclid || getCookie("_fbc")) return;
    var value = "fb.1." + Date.now() + "." + fbclid;
    document.cookie = "_fbc=" + encodeURIComponent(value) +
      "; path=/; max-age=" + FBC_MAX_AGE_S + "; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "");
  }

  /* ---------- tag loaders (skipped when the ID is not configured) ---------- */

  function loadGtm(id) {
    if (!id) return;
    window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(id);
    document.head.appendChild(s);
  }

  function loadPixel(id) {
    if (!id) return;
    /* Meta Pixel base code */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    window.fbq("init", id);
    window.fbq("track", "PageView");
  }

  /* ---------- normalization + hashing (Meta customer-information rules) ---------- */

  function normalizeEmail(v) {
    return String(v).trim().toLowerCase();
  }

  function normalizePhone(v) {
    var d = String(v).replace(/\D/g, "");
    return d.length === 10 ? "1" + d : d;
  }

  function sha256Hex(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) {
        return b.toString(16).padStart(2, "0");
      }).join("");
    });
  }

  /* ---------- form ---------- */

  function todayIso() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }

  function validate(f) {
    var errors = {};
    if (!f.name.value.trim()) errors.name = "Please enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.value.trim())) errors.email = "Please enter a valid email address.";
    if (!/^1?[2-9]\d{9}$/.test(f.phone.value.replace(/\D/g, ""))) errors.phone = "Please enter a 10-digit US phone number.";
    if (SERVICES.indexOf(f.service.value) === -1) errors.service = "Please choose a service.";
    if (!f.date.value || f.date.value < todayIso()) errors.date = "Please pick today or a later date.";
    return errors;
  }

  function showErrors(form, errors) {
    ["name", "email", "phone", "service", "date"].forEach(function (k) {
      var input = form.elements[k];
      var msg = document.getElementById("e-" + k);
      input.setAttribute("aria-invalid", errors[k] ? "true" : "false");
      msg.textContent = errors[k] || "";
    });
    var first = Object.keys(errors)[0];
    if (first) form.elements[first].focus();
  }

  function onSubmit(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var f = form.elements;
    var errors = validate(f);
    showErrors(form, errors);
    if (Object.keys(errors).length) return;

    var button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Sending…";

    var service = f.service.value;
    var attrib = readAttribution();
    var utms = {};
    UTM_KEYS.forEach(function (k) { if (attrib[k]) utms[k] = attrib[k]; });

    var eventId = crypto.randomUUID();

    Promise.all([
      sha256Hex(normalizeEmail(f.email.value)),
      sha256Hex(normalizePhone(f.phone.value))
    ]).catch(function () {
      return [null, null]; // no SubtleCrypto (insecure context): browser events still fire
    }).then(function (hashes) {
      if (window.fbq) {
        window.fbq("track", "Lead", { content_name: service }, { eventID: eventId });
      }

      var dl = { event: "generate_lead", event_id: eventId, service: service };
      Object.keys(utms).forEach(function (k) { dl[k] = utms[k]; });
      window.dataLayer.push(dl);

      var post = Promise.resolve();
      if (hashes[0] || hashes[1]) {
        post = fetch("/api/capi", {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_id: eventId,
            em: hashes[0],
            ph: hashes[1],
            service: service,
            event_source_url: location.href,
            fbp: getCookie("_fbp"),
            fbc: getCookie("_fbc"),
            utms: utms
          })
        }).catch(function () { /* keepalive request; never block the redirect */ });
      }

      var timeout = new Promise(function (r) { setTimeout(r, REDIRECT_TIMEOUT_MS); });
      return Promise.race([post, timeout]);
    }).then(function () {
      location.assign(REDIRECT_URL);
    });
  }

  function initForm() {
    var form = document.getElementById("lead-form");
    if (!form) return;
    form.elements.date.min = todayIso();
    form.addEventListener("submit", onSubmit);
    /* Back button from thank-you restores the page from bfcache: re-arm it. */
    window.addEventListener("pageshow", function (ev) {
      if (!ev.persisted) return;
      var b = form.querySelector("button[type=submit]");
      b.disabled = false;
      b.textContent = "Request my free estimate";
    });
  }

  captureAttribution();
  ensureFbc();
  loadGtm(CFG.gtmId);
  loadPixel(CFG.pixelId);
  initForm();
})();
