> **Not used in the current setup.** The live gate is Vercel Routing Middleware (`/middleware.js`) — see the root README. This Cloudflare Worker is kept as a working alternative if you ever move the gate off Vercel.

# whatisapeptide.ai — email-verified access gate

Captures **name, phone, email**, emails a one-click access link, and unlocks the site when that link is clicked.

## How it works

| Step | What happens |
|---|---|
| 1 | Visitor with no session hits any URL → gate form |
| 2 | `POST /api/request-access` → input validated, lead saved to KV, HMAC-signed token generated |
| 3 | Token emailed as `https://www.whatisapeptide.ai/verify?t=…` |
| 4 | `GET /verify` → signature, expiry and single-use all checked → session cookie set |
| 5 | Subsequent requests carry the cookie and are proxied to the real site |

The Worker sits *in front of* your existing site. You don't need to change the site itself — anything already served at that domain is simply passed through once the visitor is verified.

## Security properties

- **Tokens are HMAC-SHA256 signed** with a server-side secret, so they can't be forged or edited.
- **Single-use.** Each token carries a `jti`; once redeemed it's recorded in KV and rejected thereafter.
- **24-hour expiry** on links; **90-day** sessions (both tunable at the top of `worker.js`).
- **Cookie is `HttpOnly; Secure; SameSite=Lax`** — not readable by JavaScript.
- **Honeypot field** plus a **5-requests-per-IP-per-hour** limit to blunt bot signups.
- Gate pages send `noindex` so the form doesn't get indexed in place of your content.

## Deploy

```bash
npm install -g wrangler
wrangler login

# 1. Create the KV namespace, then paste the returned id into wrangler.toml
wrangler kv namespace create GATE

# 2. Set secrets
#    SIGNING_KEY — generate with:  openssl rand -base64 32
wrangler secret put SIGNING_KEY
wrangler secret put EMAIL_API_KEY

# 3. Ship
wrangler deploy
```

### Before it will send mail

Pick a provider in `wrangler.toml` (`resend`, `postmark` or `sendgrid` are all supported out of the box) and **verify your sending domain with them**. `FROM_EMAIL` must be on that verified domain or every send will fail.

Add SPF, DKIM and DMARC records for the domain. Skipping this is the single most common reason magic-link emails land in spam, which shows up as "the gate is broken" when it isn't.

To use a different provider, add a branch to `sendMagicLink()` in `src/worker.js` — it's one `fetch` call.

## Retrieving leads

Each verified lead is stored at key `lead:<email>`:

```bash
wrangler kv key list --binding=GATE --prefix="lead:"
wrangler kv key get --binding=GATE "lead:jane@example.com"
```

Stored fields: `name`, `phone`, `email`, `ip`, `userAgent`, `country`, `requestedAt`, `verifiedAt`.

For anything beyond occasional lookups, forward leads to your CRM at the point of capture rather than polling KV — add the call next to the `env.GATE.put(\`lead:${email}\`…)` line in the `/api/request-access` handler.

## Delivering the PDF

Two options:

1. **Host it behind the gate.** Drop `The_Peptide_Playbook.pdf` on the site and link it from the post-verification page. Only verified sessions can reach it.
2. **Attach or link it in the email.** Add a second link in `sendMagicLink()`. Simpler, but the file then circulates freely.

Option 1 keeps the gate meaningful; option 2 converts better. Most lead magnets use option 1 with a prominent download link on the unlocked landing page.

## Local testing

```bash
wrangler dev
```

Pass-through fetching won't resolve locally the way it does on the edge, so test the **form → email → verify** path in `wrangler dev`, and confirm the proxying behaviour after deploying to a staging route.

## Tuning

At the top of `src/worker.js`:

```js
const TOKEN_TTL_SECONDS   = 60 * 60 * 24;       // link lifetime
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90;  // access lifetime
const MAX_REQUESTS_PER_IP_PER_HOUR = 5;
```

## One legal note

You're collecting name, phone and email and storing them. Depending on where your visitors are, that brings GDPR/CCPA obligations, and the phone number specifically implicates TCPA rules if you ever call or text. Worth having a privacy policy linked from the form and explicit consent language before you use the phone numbers for outreach — the current form text covers contact permission but isn't a substitute for counsel.
