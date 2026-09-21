/**
 * whatisapeptide.ai — email-verified access gate
 *
 * Flow:
 *   1. Visitor without a session hits any page  -> gate form (name, phone, email)
 *   2. POST /api/request-access                 -> lead saved, signed token emailed
 *   3. Visitor clicks emailed link /verify?t=   -> token checked, session cookie set
 *   4. Subsequent requests                      -> proxied through to the origin site
 *
 * Bindings required (see wrangler.toml):
 *   KV namespace  GATE        - leads, single-use token tracking, rate limits
 *   Secret        SIGNING_KEY - HMAC key for tokens and session cookies
 *   Secret        EMAIL_API_KEY
 *   Vars          SITE_URL, FROM_EMAIL, FROM_NAME, EMAIL_PROVIDER
 */

const TOKEN_TTL_SECONDS = 60 * 60 * 24; // magic link valid 24h
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // access lasts 90 days
const SESSION_COOKIE = "wap_access";
const MAX_REQUESTS_PER_IP_PER_HOUR = 5;

/* ---------------------------------------------------------------- crypto */

const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]
  );
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payloadObj, secret) {
  const payload = b64url(enc.encode(JSON.stringify(payloadObj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** Verifies signature and expiry. Returns payload object or null. */
async function verify(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const key = await hmacKey(secret);
  const expected = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  // constant-time-ish comparison via re-encoding
  if (b64url(expected) !== sig) return null;

  let data;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    data = JSON.parse(json);
  } catch { return null; }

  if (!data.exp || Date.now() / 1000 > data.exp) return null;
  return data;
}

/* ------------------------------------------------------------ validation */

function cleanEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  // deliberately permissive but structurally strict
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(s) && s.length <= 254 ? s : null;
}

function cleanPhone(v) {
  const digits = String(v || "").replace(/[^\d+]/g, "");
  const bare = digits.replace(/\D/g, "");
  return bare.length >= 7 && bare.length <= 15 ? digits : null;
}

function cleanName(v) {
  const s = String(v || "").trim().replace(/\s+/g, " ");
  return s.length >= 2 && s.length <= 100 ? s : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* ----------------------------------------------------------------- email */

async function sendMagicLink(env, { name, email, link }) {
  const subject = "Your access link — The Peptide Playbook";
  const text =
`Hi ${name},

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
    headers = { "X-Postmark-Server-Token": env.EMAIL_API_KEY, "Content-Type": "application/json", Accept: "application/json" };
    body = { From: from, To: email, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: "outbound" };

  } else if (provider === "sendgrid") {
    url = "https://api.sendgrid.com/v3/mail/send";
    headers = { Authorization: `Bearer ${env.EMAIL_API_KEY}`, "Content-Type": "application/json" };
    body = {
      personalizations: [{ to: [{ email }] }],
      from: { email: env.FROM_EMAIL, name: env.FROM_NAME || "whatisapeptide.ai" },
      subject,
      content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }],
    };

  } else {
    throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Email send failed (${res.status}): ${detail.slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ HTML */

function gatePage(message = "", ok = false) {
  const banner = message
    ? `<div class="msg ${ok ? "ok" : "err"}">${escapeHtml(message)}</div>`
    : "";

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

      <!-- honeypot: real users never fill this -->
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

function noticePage(title, body, tone = "ok") {
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
</style></head><body><div class="box"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`;
}

/* ------------------------------------------------------------------ util */

function cookieFrom(req, name) {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}

/* ---------------------------------------------------------------- router */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- 1. verify a magic link -------------------------------------------
    if (path === "/verify") {
      const token = url.searchParams.get("t");
      const data = await verify(token, env.SIGNING_KEY);

      if (!data || data.k !== "magic") {
        return new Response(
          noticePage("Link expired or invalid",
            `<p>Access links work once and expire after 24 hours.</p>
             <p><a href="/">Request a new link</a></p>`, "err"),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // single-use enforcement
      const usedKey = `used:${data.jti}`;
      if (await env.GATE.get(usedKey)) {
        return new Response(
          noticePage("This link was already used",
            `<p>For security, each access link works only once.</p>
             <p><a href="/">Request a new link</a></p>`, "err"),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      await env.GATE.put(usedKey, "1", { expirationTtl: TOKEN_TTL_SECONDS });

      const session = await sign({
        k: "session",
        email: data.email,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      }, env.SIGNING_KEY);

      ctx.waitUntil(env.GATE.put(
        `lead:${data.email}`,
        JSON.stringify({ ...(data.lead || {}), verifiedAt: new Date().toISOString() })
      ));

      return redirect("/", {
        "Set-Cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      });
    }

    // --- 2. handle the gate form ------------------------------------------
    if (path === "/api/request-access" && request.method === "POST") {
      const form = await request.formData();

      if (form.get("company")) {
        // honeypot tripped — pretend success, send nothing
        return new Response(noticePage("Check your email",
          `<p>If the details are valid, your access link is on its way.</p>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const name = cleanName(form.get("name"));
      const phone = cleanPhone(form.get("phone"));
      const email = cleanEmail(form.get("email"));

      if (!name || !phone || !email) {
        const which = !name ? "a valid full name" : !phone ? "a valid phone number" : "a valid email address";
        return new Response(gatePage(`Please enter ${which}.`), {
          status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // crude per-IP rate limit
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rlKey = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
      const count = parseInt(await env.GATE.get(rlKey) || "0", 10);
      if (count >= MAX_REQUESTS_PER_IP_PER_HOUR) {
        return new Response(gatePage("Too many requests. Please try again in an hour."), {
          status: 429, headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      ctx.waitUntil(env.GATE.put(rlKey, String(count + 1), { expirationTtl: 3600 }));

      const lead = {
        name, phone, email,
        ip,
        userAgent: request.headers.get("User-Agent") || "",
        country: request.headers.get("CF-IPCountry") || "",
        requestedAt: new Date().toISOString(),
      };
      ctx.waitUntil(env.GATE.put(`lead:${email}`, JSON.stringify(lead)));

      const jti = crypto.randomUUID();
      const token = await sign({
        k: "magic", jti, email, lead,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      }, env.SIGNING_KEY);

      const link = `${env.SITE_URL.replace(/\/$/, "")}/verify?t=${encodeURIComponent(token)}`;

      try {
        await sendMagicLink(env, { name, email, link });
      } catch (err) {
        console.error("send failure", err.message);
        return new Response(gatePage("We couldn't send that email. Please check the address and try again."), {
          status: 502, headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(noticePage("Check your email",
        `<p>We've sent an access link to <strong>${escapeHtml(email)}</strong>.</p>
         <p>Click it to unlock the site and your free copy of the guide. The link expires in 24 hours.</p>
         <p style="font-size:13px;color:#7c8b93;margin-top:18px;">Not there? Check spam, or <a href="/">try again</a>.</p>`),
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- 3. everything else: gated ----------------------------------------
    const session = await verify(cookieFrom(request, SESSION_COOKIE), env.SIGNING_KEY);

    if (session && session.k === "session") {
      // authorised: pass through to the real site
      return fetch(request);
    }

    // allow the asset the gate itself needs, if any, before gating
    if (request.method !== "GET") {
      return new Response("Unauthorized", { status: 401 });
    }

    return new Response(gatePage(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  },
};
