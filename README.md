# whatisapeptide.ai

The Peptide Playbook — an evidence-graded educational guide — plus the static site that serves it and the email-verified access gate in front of it.

Everything runs on Vercel. Cloudflare is DNS only.

## Repository layout

```
/                       static site (one directory per chapter)
  index.html            landing page
  style.css             hand-maintained; not generated
  middleware.js         the access gate — runs before every request
  package.json          "type": "module" + @vercel/edge
  vercel.json           clean URLs, security headers, framework: null
  build_site.py         regenerates chapter HTML from playbook.md
  playbook.md           the manuscript — single source of truth
  The_Peptide_Playbook.pdf
/gate                   ALTERNATIVE: the same gate as a Cloudflare Worker.
                        Not used in this setup. See gate/README.md.
```

**`playbook.md` is the source of truth.** Edit it, then run `python3 build_site.py` to regenerate every chapter page. Don't hand-edit the generated HTML — the next build overwrites it. `build_site.py` does not emit `style.css`; that one is maintained by hand.

## How the gate works

```
request
  ↓
middleware.js  ── no valid session? → gate form → magic link by email
  ↓  session valid → next()
static site
```

Vercel Routing Middleware runs before every request matching its `config.matcher`, so the gate needs no separate `/api` functions — the form POST at `/api/request-access` and the magic-link check at `/verify` are both handled inside `middleware.js`. When a valid session cookie is present it calls `next()` and the request continues to the static file.

### Security properties

- **HMAC-SHA256 signed tokens.** Can't be forged or edited client-side.
- **Single-use links** via a `jti` recorded in the KV store and rejected on reuse.
- **24-hour link expiry**, **90-day sessions**. Both tunable at the top of `middleware.js`.
- **`HttpOnly; Secure; SameSite=Lax`** session cookie — not readable by JavaScript.
- **Honeypot field** plus **5 requests per IP per hour**.
- Gate pages send `noindex`.

### Degraded mode

If `KV_REST_API_URL` / `KV_REST_API_TOKEN` are absent, the gate still works: tokens remain signed and time-limited, and leads are still captured in the token payload. What you lose is single-use enforcement, rate limiting, and stored leads. Fine for a smoke test; **not** what you want in production.

## Setup

### 1. Environment variables

Project Settings → Environment Variables:

| Variable | Notes |
|---|---|
| `SIGNING_KEY` | `openssl rand -base64 32` |
| `EMAIL_API_KEY` | from your email provider |
| `EMAIL_PROVIDER` | `resend`, `postmark` or `sendgrid` — default `resend` |
| `FROM_EMAIL` | must be on a domain **verified with that provider** |
| `FROM_NAME` | optional display name |
| `SITE_URL` | `https://www.whatisapeptide.ai` |

### 2. KV store

Add **Upstash Redis** from the Vercel Marketplace (Storage tab) and connect it to this project. Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically — the middleware talks to it over REST, so no SDK and no Node runtime needed.

### 3. Email deliverability

Verify your sending domain with the provider and add its SPF, DKIM and DMARC records in Cloudflare. Skipping this is the most common reason magic links land in spam, which presents as "the gate is broken" when it isn't.

### 4. DNS in Cloudflare

Because the gate now lives in Vercel, these records should be **DNS-only (grey cloud)**. Proxying adds a hop that buys nothing here and complicates TLS.

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `@` | `76.76.21.21` | DNS only |
| CNAME | `www` | `cname.vercel-dns.com` | DNS only |

Confirm the current target values in Vercel → Project → Domains before applying; Vercel has changed them before. Add the domain in Vercel too, so the origin accepts the host header.

## Retrieving leads

Leads are stored in Upstash under `lead:<email>`, with fields `name`, `phone`, `email`, `ip`, `userAgent`, `country`, `requestedAt`, `verifiedAt`. Browse them in the Upstash console, or query by prefix from the REST API.

For anything beyond occasional lookups, forward leads to your CRM at the point of capture — add the call beside the `kvSetEx(env, \`lead:${email}\`…)` line rather than polling the store.

## Delivering the PDF

`The_Peptide_Playbook.pdf` sits behind the gate, so only verified sessions can reach it. Link it prominently from the landing page after verification. Attaching it to the email instead converts better but lets the file circulate freely, which defeats the point of gating.

## Editorial standards

Two rules govern this content, and both are deliberate:

**Every factual claim is sourced**, with regulatory claims cited to the agency's own documents rather than secondary commentary. FDA safety findings are quoted verbatim.

**No dosing information is published for unapproved compounds.** For several substances covered here the FDA has stated it "has not identified any human exposure data" by any route — there is no dose to publish, only numbers circulating on forums. Trial regimens appear only for approved medicines, tied to a cited trial.

If you edit `playbook.md`, keep both.

## Disclaimer

Educational and informational content only. Not medical advice.
