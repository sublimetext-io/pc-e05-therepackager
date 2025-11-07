Deploy: Cloudflare Workers (repackager.sublimetext.io)

Overview
- This repo is a Cloudflare Worker (see `wrangler.toml`, `src/index.js`).
- GitHub Actions deploys on every push to `main` or via manual dispatch.
- Custom domain mapping to `repackager.sublimetext.io` is preconfigured in `wrangler.toml` using `custom_domain = true`.

Prerequisites
- The `sublimetext.io` DNS zone is managed by Cloudflare (nameservers pointing to Cloudflare).
- A Cloudflare account with permission to deploy Workers and manage routes on that zone.
- GitHub repo admin permissions to add repository secrets.

What gets created/used
- Worker name: `repackager` (from `wrangler.toml`).
- No server/VPS is required. Cloudflare handles TLS, scaling, and routing.
- Custom domain mapping is declared in `wrangler.toml` via `routes = [{ pattern = "repackager.sublimetext.io", custom_domain = true }]` and is applied on deploy.

GitHub Actions setup
1) Repo already contains `.github/workflows/deploy.yml`.
   - It installs dependencies and runs `npx wrangler deploy`.
   - It reads the following secrets:
     - `CLOUDFLARE_API_TOKEN`
     - `CLOUDFLARE_ACCOUNT_ID`

2) Add GitHub secrets:
   - In GitHub: Settings → Secrets and variables → Actions → New repository secret
   - Add `CLOUDFLARE_API_TOKEN` with the API token you create below.
   - Add `CLOUDFLARE_ACCOUNT_ID` with your Cloudflare Account ID.

Create a Cloudflare API token (least-privilege)
Option A — Use the “Edit Cloudflare Workers” template (easiest)
- Cloudflare Dashboard → My Profile (top-right) → API Tokens → Create Token.
- Choose template: “Edit Cloudflare Workers”.
- Restrict to the specific Account (and optionally specific Zone) that holds `sublimetext.io`.
- Create and copy the token value; store it as the `CLOUDFLARE_API_TOKEN` GitHub secret.

Option B — Custom token (if you prefer explicit scopes)
- Cloudflare Dashboard → My Profile → API Tokens → Create Token → Create Custom Token.
- Scopes (minimum):
  - Account → Workers Scripts: Edit
  - Zone → Workers Routes: Edit
  - Zone → Zone: Read (limit to the `sublimetext.io` zone)
- Resources: limit to the specific Account and the `sublimetext.io` Zone.
- Create and copy the token value; store it as the `CLOUDFLARE_API_TOKEN` GitHub secret.

Find your Cloudflare Account ID
- Cloudflare Dashboard → Select your account (left nav) → Overview.
- The Account ID appears on the right side of the Overview page (or under Workers & Pages → Overview).
- Copy this value into the `CLOUDFLARE_ACCOUNT_ID` GitHub secret.

Custom domain: repackager.sublimetext.io
- Already configured in `wrangler.toml` as a custom domain and applied by CI on deploy.
- Alternative (dashboard-only): Workers & Pages → select `repackager` → Triggers → Custom Domains → Add `repackager.sublimetext.io`.

Do I need to set up DNS records?
- If `sublimetext.io` is already on Cloudflare, no manual DNS records are needed. The custom domain wires traffic at the edge, and TLS certs are auto-provisioned.
- If the domain is not on Cloudflare, move DNS to Cloudflare (change nameservers at your registrar) before using Workers custom domains.

Triggering a deploy
- Push to `main` → deploy runs automatically and applies the custom domain mapping from `wrangler.toml`.
- Or run manually: GitHub → Actions → Deploy Worker → Run workflow.

Local development and manual deploys
- Dev server: `npm run start` (runs `wrangler dev`).
- Manual deploy: `npm run deploy` or `npx wrangler deploy`.
  - For local/manual deploys, authenticate wrangler once: `npx wrangler login` (opens browser)
  - Or set the same env vars you use in CI (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).

Notes about this Worker
- Caches responses at the edge using `caches.default` with long-lived cache headers.
- Expects a `?url=` pointing at a ZIP and optional `?name=` to name the resulting `.sublime-package`.
- Security: `?url=` must use HTTPS and match an allowlist of hosts defined in `wrangler.toml` under `[vars].ALLOW_HOSTS`. Default is `codeload.github.com, bitbucket.org, codelab.org, gitlab.com`.
- Size cap: upstream ZIPs larger than `MAX_ZIP_BYTES` (default 25 MB) are rejected with HTTP 413.

Troubleshooting
- 403 during deploy: the API token is missing scopes (add Workers Scripts:Edit and Workers Routes:Edit) or is for the wrong account/zone.
- Route not applied: ensure you added either a Custom Domain (Dashboard) or a `routes` entry in `wrangler.toml` and that the token has permission to edit routes.
- Not served on the subdomain: confirm the `sublimetext.io` zone is on Cloudflare (nameservers set) and that the custom domain/route exists and is active.
- 400/403 at runtime: the provided `?url=` is invalid, non-HTTPS, points to localhost/IP, or its hostname is not in `ALLOW_HOSTS`.
- 413 at runtime: the upstream ZIP exceeds `MAX_ZIP_BYTES`.
