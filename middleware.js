/**
 * whatisapeptide.ai — email-verified access gate (Vercel Routing Middleware)
 *
 * Single-platform replacement for the Cloudflare Worker gate. Runs before every
 * request, so no separate /api functions are needed — the form POST and the
 * magic-link verification are handled here too.
 *
 *   1. No session on any page        -> gate form (name, phone, email)
 *   2. POST /api/request-access      -> lead stored, signed token emailed
 *   3. GET  /verify?t=…              -> token checked, session cookie set
 *   4. Valid session                 -> next(), request continues to the static site
 *
 * Environment variables (Project Settings -> Environment Variables):
 *   SIGNING_KEY        HMAC key for tokens and session cookies. openssl rand -base64 32
 *   EMAIL_API_KEY      API key for your email provider
 *   EMAIL_PROVIDER     resend | postmark | sendgrid          (default: resend)
 *   FROM_EMAIL         sender on a domain verified with that provider
 *   FROM_NAME          optional display name
 *   SITE_URL           https://www.whatisapeptide.ai
 *   KV_REST_API_URL    Upstash Redis REST endpoint  (auto-set by the Vercel integration)
 *   KV_REST_API_TOKEN  Upstash Redis REST token     (auto-set by the Vercel integration)
 */

import { next } from "@vercel/edge";

const TOKEN_TTL_SECONDS = 60 * 60 * 24; // magic link valid 24h
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // access lasts 90 days
const SESSION_COOKIE = "wap_access";
const MAX_REQUESTS_PER_IP_PER_HOUR = 5;

/* ------------------------------------------------------------------ store */
/* Upstash Redis over REST — works in the Edge runtime, no SDK required. */

/**
 * Vercel's Upstash integration prefixes injected variables with the store name
 * (e.g. WHATISAPEPTIDE_KV_REST_API_URL).
 *
 * These MUST be referenced statically. The Edge runtime inlines each
 * `process.env.X` it can see at build time and does not expose process.env as
 * an enumerable object, so scanning Object.keys(env) finds nothing at runtime.
 * If the store is ever renamed, either add a line here or set the plain
 * KV_REST_API_* names by hand in Project Settings.
 */
function kvCreds(env) {
  return {
    url: env.KV_REST_API_URL || env.WHATISAPEPTIDE_KV_REST_API_URL || null,
    token: env.KV_REST_API_TOKEN || env.WHATISAPEPTIDE_KV_REST_API_TOKEN || null,
  };
}

function storeConfigured(env) {
  const { url, token } = kvCreds(env);
  return Boolean(url && token);
}

async function kvCommand(env, pathParts, { body, query } = {}) {
  const creds = kvCreds(env);
  const url =
    `${creds.url.replace(/\/$/, "")}/` +
    pathParts.map(encodeURIComponent).join("/") +
    (query ? `?${query}` : "");

  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${creds.token}` },
    body,
  });
  if (!res.ok) throw new Error(`KV ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).result;
}

const kvGet = (env, key) => kvCommand(env, ["get", key]);

const kvSetEx = (env, key, value, ttl) =>
  kvCommand(env, ["set", key], { body: value, query: `EX=${ttl}` });

async function kvIncrEx(env, key, ttl) {
  const n = await kvCommand(env, ["incr", key]);
  if (n === 1) await kvCommand(env, ["expire", key, String(ttl)]);
  return n;
}

/* ---------------------------------------------------------------- crypto */

const enc = new TextEncoder();

const hmacKey = (secret) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(payloadObj, secret) {
  const payload = b64url(enc.encode(JSON.stringify(payloadObj)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** Verifies signature and expiry. Returns the payload, or null. */
async function verify(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  if (b64url(expected) !== sig) return null;

  let data;
  try {
    data = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
  if (!data.exp || Date.now() / 1000 > data.exp) return null;
  return data;
}

/* ------------------------------------------------------------ validation */

function cleanEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(s) && s.length <= 254 ? s : null;
}

function cleanPhone(v) {
  const kept = String(v || "").replace(/[^\d+]/g, "");
  const digits = kept.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? kept : null;
}

function cleanName(v) {
  const s = String(v || "").trim().replace(/\s+/g, " ");
  return s.length >= 2 && s.length <= 100 ? s : null;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ----------------------------------------------------------------- email */

async function sendMagicLink(env, { name, email, link }) {
  const subject = "Your access link — The Peptide Playbook";
  const text = `Hi ${name},

Here's your access link to whatisapeptide.ai and your free copy of The Peptide Playbook:

${link}

This link works once and expires in 24 hours.

If you didn't request this, you can ignore this email.

— whatisapeptide.ai
Educational content only. Not medical advice.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f7f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f8;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
  <tr><td style="background:linear-gradient(135deg,#0d3a44,#2b838c);padding:26px 30px;">
    <div style="color:#9fe3d6;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;font-weight:600;">whatisapeptide.ai</div>
    <div style="color:#ffffff;font-size:23px;font-weight:700;margin-top:6px;">The Peptide Playbook</div>
  </td></tr>
  <tr><td style="padding:30px;color:#22303a;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 16px;">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 24px;">Your access link is ready. Click below to unlock the site and download your free copy of the guide.</p>
    <p style="margin:0 0 24px;text-align:center;">
      <a href="${link}" style="display:inline-block;background:#16555f;color:#ffffff;text-decoration:none;padding:13px 30px;border-radius:6px;font-weight:600;font-size:15px;">Unlock access</a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#5b6b74;">This link works once and expires in 24 hours.</p>
    <p style="margin:0;font-size:13px;color:#5b6b74;">If the button doesn't work, paste this into your browser:<br>
      <span style="color:#2b838c;word-break:break-all;">${link}</span></p>
  </td></tr>
  <tr><td style="padding:18px 30px;background:#eef5f6;color:#6b7c85;font-size:11px;line-height:1.5;">
    Educational and informational content only. Not medical advice. If you didn't request this, ignore this email.
  </td></tr>
</table></td></tr></table></body></html>`;

  const provider = (env.EMAIL_PROVIDER || "resend").toLowerCase();
  const from = `${env.FROM_NAME || "whatisapeptide.ai"} <${env.FROM_EMAIL}>`;
  let url, body, headers;

  if (provider === "resend") {
    url = "https://api.resend.com/emails";
    headers = { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" };
    body = { from, to: [email], subject, html, text };
  } else if (provider === "postmark") {
    url = "https://api.postmarkapp.com/email";
    headers = {
      "X-Postmark-Server-Token": env.EMAIL_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    body = { From: from, To: email, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: "outbound" };
  } else if (provider === "sendgrid") {
    url = "https://api.sendgrid.com/v3/mail/send";
    headers = { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" };
    body = {
      personalizations: [{ to: [{ email }] }],
      from: { email: env.FROM_EMAIL, name: env.FROM_NAME || "whatisapeptide.ai" },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    };
  } else {
    throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Email send failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

/* ------------------------------------------------------------------ HTML */

function gatePage(message = "", ok = false) {
  const banner = message ? `<div class="msg ${ok ? "ok" : "err"}">${escapeHtml(message)}</div>` : "";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Get your free copy — The Peptide Playbook</title>
<meta name="robots" content="noindex">
<style>
:root{--ink:#22303a;--teal:#16555f;--teal-d:#0d3a44;--teal-l:#2b838c;--mint:#9fe3d6;
box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
background:linear-gradient(158deg,#0d3a44 0%,#16555f 46%,#2b838c 100%);color:var(--ink);
display:flex;align-items:center;justify-content:center;padding:28px 16px;}
.card{width:100%;max-width:940px;background:#fff;border-radius:14px;overflow:hidden;
box-shadow:0 22px 60px rgba(0,0,0,.3);display:grid;grid-template-columns:1fr 1fr;}
.pitch{background:linear-gradient(150deg,#0d3a44,#1d6b74);color:#fff;padding:40px 36px;}
.kicker{color:var(--mint);font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:700}
.pitch h1{font-size:30px;line-height:1.15;margin:16px 0 14px;letter-spacing:-.5px}
.pitch p{color:#d6f0ec;font-size:14.5px;line-height:1.6;margin:0 0 20px}
.pitch ul{list-style:none;padding:0;margin:0;color:#cbeae4;font-size:13.5px;line-height:1.5}
.pitch li{padding-left:20px;position:relative;margin-bottom:11px}
.pitch li:before{content:"";position:absolute;left:0;top:6px;width:7px;height:7px;background:var(--mint);border-radius:2px}
.form{padding:40px 36px}
.form h2{margin:0 0 6px;font-size:21px;color:var(--teal-d)}
.form .sub{margin:0 0 22px;font-size:13.5px;color:#5b6b74;line-height:1.5}
label{display:block;font-size:12.5px;font-weight:600;color:var(--teal);margin:0 0 6px}
input{width:100%;padding:11px 13px;border:1.5px solid #d4dee1;border-radius:7px;font-size:15px;
margin-bottom:15px;font-family:inherit;color:var(--ink);background:#fff}
input:focus{outline:none;border-color:var(--teal-l);box-shadow:0 0 0 3px rgba(43,131,140,.14)}
button{width:100%;padding:13px;background:var(--teal);color:#fff;border:0;border-radius:7px;
font-size:15.5px;font-weight:600;cursor:pointer;font-family:inherit}
button:hover{background:var(--teal-d)}
button[disabled]{opacity:.6;cursor:not-allowed}
.fine{margin-top:16px;font-size:11.5px;color:#7c8b93;line-height:1.55}
.msg{padding:11px 13px;border-radius:7px;font-size:13.5px;margin-bottom:18px;line-height:1.5}
.msg.err{background:#fdecec;color:#8a1f1f;border:1px solid #f3c9c9}
.msg.ok{background:#e9f6f2;color:#14574b;border:1px solid #b9e2d6}
@media(max-width:760px){.card{grid-template-columns:1fr}.pitch{padding:30px 26px}.form{padding:30px 26px}.pitch h1{font-size:25px}}
</style></head><body>
<main class="card">
  <section class="pitch">
    <div class="kicker">whatisapeptide.ai</div>
    <h1>The Peptide Playbook</h1>
    <p>An evidence-graded guide to what peptides are, what the research actually shows, and how to read the claims.</p>
    <ul>
      <li>Every claim sourced to named trials and regulatory documents</li>
      <li>Evidence graded: Strong &middot; Moderate &middot; Limited &middot; Preclinical</li>
      <li>FDA safety findings quoted verbatim, not paraphrased</li>
      <li>Current regulatory status through 2026</li>
      <li>Free &mdash; no payment, no upsell</li>
    </ul>
  </section>
  <section class="form">
    <h2>Get instant access</h2>
    <p class="sub">Tell us where to send your link. We'll email you a one-click link that unlocks the site and your free copy of the guide.</p>
    ${banner}
    <form method="POST" action="/api/request-access" id="f">
      <label for="name">Full name</label>
      <input id="name" name="name" type="text" autocomplete="name" required maxlength="100" placeholder="Jane Doe">

      <label for="phone">Phone number</label>
      <input id="phone" name="phone" type="tel" autocomplete="tel" required placeholder="(555) 123-4567">

      <label for="email">Email address</label>
      <input id="email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="jane@example.com">

      <input type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true"
             style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">

      <button type="submit" id="b">Email me my access link</button>
    </form>
    <p class="fine">By submitting you agree we may contact you at the details provided.
    This guide is educational content only and is not medical advice.</p>
  </section>
</main>
<script>
document.getElementById('f').addEventListener('submit',function(){
  var b=document.getElementById('b'); b.disabled=true; b.textContent='Sending…';
});
</script>
</body></html>`;
}

function noticePage(title, bodyHtml, tone = "ok") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title><meta name="robots" content="noindex"><style>
:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
html,body{margin:0;height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
background:linear-gradient(158deg,#0d3a44,#2b838c);display:flex;align-items:center;justify-content:center;padding:24px}
.box{background:#fff;border-radius:13px;padding:40px 34px;max-width:470px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.28)}
h1{margin:0 0 12px;font-size:22px;color:${tone === "ok" ? "#0d3a44" : "#8a1f1f"}}
p{margin:0 0 10px;color:#4a5a63;font-size:15px;line-height:1.6}
a{color:#2b838c;font-weight:600;text-decoration:none}
</style></head><body><div class="box"><h1>${escapeHtml(title)}</h1>${bodyHtml}</div></body></html>`;
}

const html = (body, status = 200, extra = {}) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      ...extra,
    },
  });

function cookieFrom(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/* ------------------------------------------------------------ middleware */

export const config = {
  runtime: "edge",
  // Everything except Vercel internals and the static assets the gate itself needs.
  matcher: ["/((?!_vercel|favicon.svg|robots.txt).*)"],
};

export default async function middleware(request, context) {
  const env = process.env;
  const url = new URL(request.url);
  const path = url.pathname;

  if (!env.SIGNING_KEY) {
    return html(
      noticePage("Gate not configured", "<p>SIGNING_KEY is not set for this environment.</p>", "err"),
      500
    );
  }

  /* --- 1. verify a magic link ------------------------------------------ */
  if (path === "/verify") {
    const data = await verify(url.searchParams.get("t"), env.SIGNING_KEY);
    if (!data || data.k !== "magic") {
      return html(
        noticePage(
          "Link expired or invalid",
          `<p>Access links work once and expire after 24 hours.</p><p><a href="/">Request a new link</a></p>`,
          "err"
        ),
        400
      );
    }

    // single-use enforcement
    if (storeConfigured(env)) {
      const usedKey = `used:${data.jti}`;
      try {
        if (await kvGet(env, usedKey)) {
          return html(
            noticePage(
              "This link was already used",
              `<p>For security, each access link works only once.</p><p><a href="/">Request a new link</a></p>`,
              "err"
            ),
            400
          );
        }
        await kvSetEx(env, usedKey, "1", TOKEN_TTL_SECONDS);
        context.waitUntil(
          kvSetEx(
            env,
            `lead:${data.email}`,
            JSON.stringify({ ...(data.lead || {}), verifiedAt: new Date().toISOString() }),
            60 * 60 * 24 * 365
          )
        );
      } catch (err) {
        console.error("kv error on verify", err.message);
      }
    }

    const session = await sign(
      { k: "session", email: data.email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
      env.SIGNING_KEY
    );

    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      },
    });
  }

  /* --- 2. handle the gate form ----------------------------------------- */
  if (path === "/api/request-access" && request.method === "POST") {
    const form = await request.formData();

    if (form.get("company")) {
      // honeypot tripped — look successful, send nothing
      return html(noticePage("Check your email", `<p>If the details are valid, your access link is on its way.</p>`));
    }

    const name = cleanName(form.get("name"));
    const phone = cleanPhone(form.get("phone"));
    const email = cleanEmail(form.get("email"));

    if (!name || !phone || !email) {
      const which = !name ? "a valid full name" : !phone ? "a valid phone number" : "a valid email address";
      return html(gatePage(`Please enter ${which}.`), 400);
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

    if (storeConfigured(env)) {
      try {
        const rlKey = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
        if ((await kvIncrEx(env, rlKey, 3600)) > MAX_REQUESTS_PER_IP_PER_HOUR) {
          return html(gatePage("Too many requests. Please try again in an hour."), 429);
        }
      } catch (err) {
        console.error("kv error on rate limit", err.message);
      }
    }

    const lead = {
      name,
      phone,
      email,
      ip,
      userAgent: request.headers.get("User-Agent") || "",
      country: request.headers.get("x-vercel-ip-country") || "",
      requestedAt: new Date().toISOString(),
    };

    if (storeConfigured(env)) {
      context.waitUntil(
        kvSetEx(env, `lead:${email}`, JSON.stringify(lead), 60 * 60 * 24 * 365).catch((e) =>
          console.error("kv error storing lead", e.message)
        )
      );
    }

    const token = await sign(
      {
        k: "magic",
        jti: crypto.randomUUID(),
        email,
        lead,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      },
      env.SIGNING_KEY
    );

    const base = (env.SITE_URL || url.origin).replace(/\/$/, "");
    const link = `${base}/verify?t=${encodeURIComponent(token)}`;

    try {
      await sendMagicLink(env, { name, email, link });
    } catch (err) {
      console.error("send failure", err.message);
      return html(gatePage("We couldn't send that email. Please check the address and try again."), 502);
    }

    return html(
      noticePage(
        "Check your email",
        `<p>We've sent an access link to <strong>${escapeHtml(email)}</strong>.</p>
         <p>Click it to unlock the site and your free copy of the guide. The link expires in 24 hours.</p>
         <p style="font-size:13px;color:#7c8b93;margin-top:18px;">Not there? Check spam, or <a href="/">try again</a>.</p>`
      )
    );
  }

  /* --- 3. everything else: gated --------------------------------------- */
  const session = await verify(cookieFrom(request, SESSION_COOKIE), env.SIGNING_KEY);
  if (session && session.k === "session") return next();

  if (request.method !== "GET") return new Response("Unauthorized", { status: 401 });

  return html(gatePage());
}
