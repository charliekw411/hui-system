# Hui Management System

A simple, dignified web application for the **Pehiāweri B1B Ahu Whenua Trust** to publish hui (meeting) notices, Zoom details, and documents — replacing the old workflow of Gmail invitation chains, recurring Google Calendar events, and manually managed Zoom links.

> _oranga whenua · oranga reo_

It is built to be operated by the trust's approved trustees, and is fully self-contained: once deployed it depends on **no AI service** at runtime.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Tech stack](#tech-stack)
3. [Local development setup](#1-local-development-setup)
4. [Supabase project setup & running the migration](#2-supabase-project-setup--running-the-migration)
5. [Cloudflare Pages + Workers deployment](#3-cloudflare-pages--workers-deployment)
6. [Environment variables](#4-environment-variables)
7. [Preserving the trust administrator and adding trustees](#5-preserving-the-trust-administrator-and-adding-trustees)
8. [For Trustees: How to create a Hui](#6-for-trustees-how-to-create-a-hui)
9. [Trustee authentication migration](#7-trustee-authentication-migration)

---

## What it does

- **Public site (`/`)** — shows the next upcoming published hui (title, date, time, location, _Join Zoom_ button, passcode, agenda download, attached documents) and an archive of previous hui. No login required.
- **Admin portal (`/admin`)** — Google Sign-In for active, allowlisted trustees, plus the unchanged trust administrator's emergency email/password login. Every approved trustee can create, edit, publish, cancel, and delete hui and upload documents. Dashboard lists every hui with its status (draft / published / cancelled).
- **Zoom** — manual only. Trustees paste their own Zoom link and passcode into the form. There is no Zoom API or OAuth.

## Tech stack

| Layer    | Technology                                   |
| -------- | -------------------------------------------- |
| Frontend | Astro (hybrid SSR) + TypeScript + Tailwind   |
| Backend  | Cloudflare Workers + TypeScript              |
| Database | Supabase PostgreSQL                          |
| Auth     | Supabase Auth (Google trustees + permanent password break-glass account) |
| Storage  | Supabase Storage (agendas & documents)       |
| Hosting  | Cloudflare Pages + Workers                   |

### Project structure

```text
/
├── src/
│   ├── pages/
│   │   ├── index.astro            ← public hui page
│   │   └── admin/
│   │       ├── index.astro        ← dashboard
│   │       ├── login.astro        ← login page
│   │       └── hui/
│   │           ├── new.astro      ← create hui form
│   │           └── [id].astro     ← edit hui form
│   ├── components/
│   │   ├── HuiCard.astro
│   │   ├── HuiForm.astro
│   │   └── AdminNav.astro
│   ├── layouts/
│   │   ├── Layout.astro
│   │   └── AdminLayout.astro
│   └── lib/
│       └── supabase.ts
├── workers/
│   └── api.ts                     ← Cloudflare Worker (API)
├── migrations/
│   └── 001_initial.sql
├── astro.config.mjs
├── wrangler.toml
├── tailwind.config.mjs
├── tsconfig.json
├── package.json
├── .env.example
└── README.md
```

---

## 1. Local development setup

**Prerequisites:** Node.js 18+ and npm.

```bash
# 1. Install dependencies
npm install

# 2. Create your env file for the Astro site
cp .env.example .env
#   then fill in the values (see "Environment variables" below)

# 3. Create the Worker's local secrets file
cp .env.example .dev.vars
#   .dev.vars uses the same KEY=VALUE format and is read by `wrangler dev`

# 4. Run the Astro site (public + admin pages)
npm run dev
#   → http://localhost:4321

# 5. In a second terminal, run the API Worker
npm run worker:dev
#   → http://localhost:8787
```

By default the frontend calls the API at the relative path `/api`. For local
development, set `PUBLIC_API_BASE=http://localhost:8787/api` in your `.env` so
the site talks to the locally running Worker. In production you serve the Worker
under the same domain at `/api/*` (see deployment) and can leave `PUBLIC_API_BASE`
unset.

### Useful scripts

| Command                 | Description                         |
| ----------------------- | ----------------------------------- |
| `npm run dev`           | Start the Astro dev server          |
| `npm run build`         | Build the site for production       |
| `npm run preview`       | Preview the production build        |
| `npm run check`         | Type-check the Astro project        |
| `npm test`              | Run isolated Worker authorization regressions |
| `npm run worker:dev`    | Run the API Worker locally          |
| `npm run worker:deploy` | Deploy the API Worker to Cloudflare |

---

## 2. Supabase project setup & running the migration

1. Create a free project at <https://supabase.com>.
2. Once it is ready, open **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (keep this secret!)
3. **Run the migration manually:**
   1. In the Supabase dashboard, open **SQL Editor → New query**.
   2. Open `migrations/001_initial.sql` from this repository, copy its **entire**
      contents, and paste it into the editor.
   3. Click **Run**.
   4. This creates the `hui` and `documents` tables, indexes, the `updated_at`
      trigger, Row Level Security policies, and a public Storage bucket named
      `hui-documents` for agendas and documents.

   This is the original schema/bootstrap migration, not the upgrade path for an
   existing installation. Do not rerun it during the trustee-auth upgrade.

> **Existing deployment:** apply `migrations/002_trustee_google_auth.sql` manually
> using the rollout below. Deploying the repository never applies SQL migrations.

### What RLS allows

- **Anyone (anonymous):** read **published** hui and their documents, and read
  files in the `hui-documents` bucket.
- **Authorized portal users:** the pinned trust account, or an active trustee
  with a verified Google OAuth session, have full read/write on hui and documents
  and upload/update/delete access in the bucket. All five roles have equal powers.
- **Other authenticated users:** no private hui/document access and no portal
  writes; public published content remains public. A Supabase session alone is
  insufficient.
- **Trustee membership:** no direct browser listing or writes. Membership is
  maintained by trusted Supabase administrators, not by user-editable metadata.
- The **Cloudflare Worker** uses the **service role** key, which bypasses RLS,
  and checks the verified identity and current trustee authorization on every
  private read/write request. RLS alone cannot protect a service-role Worker.

---

## 3. Cloudflare Pages + Workers deployment

This app has two deployable parts:

- the **Astro site** → Cloudflare **Pages**
- the **API** → a Cloudflare **Worker**, addressed using `PUBLIC_API_BASE`

### Current deployment method in this repository

The existing Cloudflare resources have separate Git integrations:

1. The frontend/admin Astro app is deployed via **Cloudflare Pages** from the GitHub repository (`npm run build` with `dist` output).
2. The backend API is deployed by **Workers Builds**, with no separate build
   command and deploy command `npm run worker:deploy`.
3. Both integrations track `main` in `charliekw411/hui-system`, use the repository
   root, and have automatic non-production deployments disabled.
4. Existing hosts are `hui-system.pages.dev` and
   `hui-system-api.charliekakewhite.workers.dev`. Preserve `PUBLIC_API_BASE`;
   it must include `/api` when pointing at the Worker hostname. No custom-domain
   `/api/*` route is assumed. The commented route block remains optional.
5. Secrets are managed in Cloudflare dashboards/secret stores (Pages environment variables plus Worker secrets), not in source control.

### A. Deploy the API Worker

```bash
# Log in once
npx wrangler login

# Set the Worker's secrets (you will be prompted to paste each value)
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Deploy
npm run worker:deploy
```

To serve the Worker under your domain at `/api/*`, uncomment and edit the
`[[routes]]` block in `wrangler.toml`:

```toml
[[routes]]
pattern = "yourdomain.com/api/*"
zone_name = "yourdomain.com"
```

### B. Deploy the Astro site to Pages

1. Push this repository to GitHub.
2. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages → Connect to Git** and select the repo.
3. Build settings:
   - **Framework preset:** Astro
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Under **Settings → Environment variables**, add (for Production and Preview):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - _(optional)_ `PUBLIC_API_BASE` — only needed if the Worker is **not** on the
     same domain at `/api`. If the Worker is routed at `yourdomain.com/api/*`,
     leave this unset (the site defaults to `/api`).
5. Deploy.

> The public homepage reads published content using the anon key. Admin edit
> pages render an empty form, then load private data through the authorized API.
> Pages no longer uses the service-role key to fetch private hui before login.
> Existing secrets are retained; the service-role key is never exposed to browsers.

---

## 4. Environment variables

| Variable                    | Used by                 | Secret? | Description                                           |
| --------------------------- | ----------------------- | ------- | ----------------------------------------------------- |
| `SUPABASE_URL`              | Site (SSR) + Worker     | No      | Your Supabase project URL                             |
| `SUPABASE_ANON_KEY`         | Site (browser) + Worker | No      | Public anon key (auth, public reads, Storage uploads) |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker; existing Pages secret retained | **Yes** | Service role key — never exposed to the browser |
| `PUBLIC_API_BASE`           | Site (browser)          | No      | Optional. API base URL. Defaults to `/api`            |
| `PUBLIC_GOOGLE_SIGN_IN_ENABLED` | Pages | No | Defaults to `false`; enable only after SQL, API and provider configuration are ready |

`.env` is read by Astro locally; `.dev.vars` is read by `wrangler dev`. In
production, secrets live in the Cloudflare Pages **and** Worker dashboards. Never
commit real secrets — `.env`, `.env.*`, and `.dev.vars` are git-ignored.

---

## 5. Preserving the trust administrator and adding trustees

Never recreate, rename, disable, delete, reset, or change the existing
`trust@pehiaweri.local` account as part of this migration. Its immutable Supabase
UUID is `0a84ad22-04a1-4778-8c2e-84c87c297461`. Only that verified identity receives
the independent break-glass exception; copying its email onto another account
does not grant access. Keep the Email provider and its existing password enabled.
The `.local` address is not a reliable email-recovery destination.

Add trustees to `public.trustees` through trusted database administration with
fields `id`, `email`, `name`, `role`, `active`. IDs are generated independently of
`auth.users`, so membership can be seeded before first Google login. Store emails
as `lower(trim(email))`. Roles are `Admin`, `Chair`, `Secretary`, `Treasurer`, and
`Trustee`; all have the same full portal capabilities. Set `active = false` to
deny a trustee's future authorized requests without deleting their Auth user or data.

Do not create password accounts for trustees as an alternative to Google:
non-break-glass password sessions are intentionally denied. Non-Gmail email
addresses must be associated with Google accounts that return that exact verified
email. Do not automatically equate different email addresses or Google aliases.

---

## 6. For Trustees: How to create a Hui

This section is written for a non-technical trustee. You only need a web browser.

### Signing in

1. Go to the website and click **Trustee login** at the bottom of the page
   (or go straight to `/admin`).
2. Choose **Continue with Google** and select the account matching your registered
   trustee email. The emergency trust administrator continues to use the existing
   **Email** and **Password** form.

### Creating a new hui

1. On the dashboard, click the green **+ New Hui** button.
2. Fill in the form:
   - **Title** — e.g. "Annual General Meeting" _(required)_.
   - **Date & time** — pick the date and start time. This is New Zealand time _(required)_.
   - **Location** — where the hui is held (a marae, an address, or "Online").
   - **Description** — any extra notes for whānau.
   - **Zoom link** — open Zoom, copy your meeting link, and paste it here.
   - **Zoom passcode** — paste the meeting passcode (if you have one).
   - **Status** — leave as **Draft** while you are still preparing, or choose
     **Published** to make it visible to everyone.
   - **Agenda (PDF)** — click to upload the agenda as a PDF.
   - **Additional documents** — upload any other files (you can select several).
3. Click **Create Hui**.

### Publishing a hui

- A **Draft** hui is visible to authorized trustees. When you are ready for whānau to see it,
  either set the status to **Published** in the form, or click **Publish** next to
  the hui on the dashboard.
- Only the **next upcoming published** hui appears at the top of the public page.
  Once its scheduled start time passes, a published hui moves to the **Previous Hui**
  archive. Its **Join Zoom** button and passcode remain available there so whānau
  can still join after the hui has started.

### Editing or cancelling a hui

- Click **Edit** next to a hui to change any detail or swap out documents.
- Click **Cancel** to mark a hui as cancelled (it stays in the system, shown as
  cancelled). Click **Delete** to remove it permanently — this cannot be undone.

### Signing out

- Click **Sign out** in the top-right of the admin area when you are finished.

That's it — no calendar invites, no email chains, no Zoom admin. Paste your Zoom
link, upload the agenda, and publish.

## 7. Trustee authentication migration

### Architecture before this change

The baseline is commit `1cf2a8c5a1600145502392bb681bf571ae1bb794`, including the
Zoom-history fix. Login used `signInWithPassword`; the browser persisted and
refreshed Supabase sessions under `hui-admin-auth`. API authorization called
`getUser(token)` but accepted every valid Supabase user, then used service-role
database access. Admin page gates checked browser sessions. The edit page fetched
private hui with service-role SSR before its browser gate. Storage uploads used
the browser's Supabase client directly.

Live RLS includes the original policies plus additional permissive authenticated
policies. Consequently, adding another permissive allowlist policy would not
restrict access. The upgrade adds thirteen restrictive guards alongside them.
Neither the original policies nor their grants are deleted or rewritten.

### Architecture after this change

The browser keeps the same session storage key and password flow. Google OAuth
uses PKCE and `/auth/callback`; Supabase initializes/exchanges the code once, then
the page checks `/api/auth/me` before entering the portal. Callback URLs are
cleared and use `Referrer-Policy: no-referrer`. Auth/private API responses are
`Cache-Control: no-store`.

The Worker verifies the user with Supabase `getUser(token)`. The pinned
break-glass UUID returns Admin access immediately, without querying membership.
All other private requests call `current_portal_access()` with the caller's JWT
and anon API key. The RPC returns only that user's access profile, not the roster.
Denied users get 403; an unavailable/malformed authorization service fails closed.

The database function checks signed session AMR for OAuth, the server-managed
Google identity's verified email, the current confirmed Auth email, and an active
matching trustee row with a recognized role. It does not trust user metadata or
the original signup-provider label. Password sessions with linked Google
identities do not pass. Accounts linked to other social providers fail closed
because the AMR claim alone does not identify which OAuth provider signed in.
Keep Google as the only enabled social provider.

Every portal role can perform all existing hui/document actions. Role labels are
not a privilege hierarchy. There is no new membership-management portal; direct
browser membership listing/writes remain denied to prevent self-activation.

### Required Google and Supabase configuration

| Setting | Required value |
| --- | --- |
| Google OAuth client type | Web application |
| Google audience | External, since trustee accounts span email domains |
| Google scopes | `openid`, `email`, `profile` only |
| Google authorized JavaScript origin | `https://hui-system.pages.dev` |
| Google authorized redirect URI | `https://tsbbpovddudkgnipsuwu.supabase.co/auth/v1/callback` |
| Supabase Site URL | `https://hui-system.pages.dev` |
| Supabase allowed redirect URL | `https://hui-system.pages.dev/auth/callback` |
| Supabase Google provider | Enable only after protected backend/database rollout; enter Google client ID and secret directly in Supabase |
| Skip nonce checks / allow users without email | Both off |
| Existing Email provider | Keep enabled and otherwise unchanged |
| Existing signup / confirm email | Keep enabled; allowlist authorization is separate from Auth account creation |
| Existing manual linking / anonymous sign-ins | Keep disabled |
| Pages feature flag | `PUBLIC_GOOGLE_SIGN_IN_ENABLED=true` only after readiness checks |

For a Google consent screen in Testing mode, add each trustee's actual Google
account as a test user; otherwise publish the OAuth app as appropriate. A
non-allowlisted Google user can obtain a Supabase Auth record/session but cannot
access private portal data or perform portal writes. Do not expose Google client
secrets to Pages, browser code, source control, logs, or this documentation.
Do not wildcard production redirect URLs. For local development, explicitly add
the chosen local callback to the allowlist; automatic Cloudflare previews remain off.

### Ordered rollout and preservation

1. Record known-good Pages and Worker deployment versions, current Auth settings,
   policies/grants, and backup status. Confirm the existing trust password works.
   Retain that login in a separate browser session; do not reset its password.
2. Keep Google disabled and the Pages Google feature flag false. Apply
   `migrations/002_trustee_google_auth.sql` as the trusted migration owner. It is
   transactional and aborts if the pinned account, existing public bucket, or
   existing RLS prerequisites are absent.
3. Apply the separately supplied `trustees-seed.private.sql`. It contains the nine
   approved active records and is deliberately not included in this public
   repository. Re-running does not duplicate records, overwrite names/roles, or
   reactivate an existing inactive trustee.
4. Deploy the Worker authorization changes before the new Pages UI. Verify the
   trust account can list/create/edit/publish/cancel/delete and upload documents.
   Unknown users must be denied through both API and direct database/storage access.
5. Deploy Pages, configure the exact OAuth URLs and Google credentials, enable
   Google, then set the Pages feature flag true and redeploy Pages. Exercise a
   real approved Google account before declaring production Google login ready.
6. Recheck the public hui/Zoom archive and existing trust password login. Retain
   the old data, users, original policies, Cloudflare resources, URLs and secrets.

Both production integrations track `main`; merging can deploy both concurrently.
For a strictly ordered first rollout, temporarily pause Pages automatic production
deployment (with approval), deploy the Worker commit, then deploy/resume Pages.
SQL and private seed execution are never part of a Git build.

### Risks and safe rollback

Google credentials, consent-screen audience/test-user settings, incorrect redirects,
missing migration, and using a different Google email can prevent trustee login.
Existing broad grants cannot be secured by a button or client-side check. RLS does
not constrain service-role queries or privileged SQL/TRUNCATE; never expose a
privileged database credential or arbitrary SQL RPC to the browser.

The existing `hui-documents` bucket remains **public**, including existing public
file URLs. This migration does not convert draft attachments into private files
or revoke public download links, because that would change existing functionality.

If trustee authentication fails, use the existing trust password login. Set the
Pages Google feature flag false and, when appropriate, disable Google. Apply
`migrations/manual/safe_breakglass_fallback.sql` to immediately make authorization
break-glass-only while retaining every user, row, membership record, original
policy, and restrictive guard. It is repeatable; rerunning the forward migration
restores active Google trustee access without reseeding or modifying users.

**Do not revert to the old permissive Worker or remove the new guards while
non-break-glass sessions exist.** Disabling a provider does not invalidate issued
tokens. A password-only UI rollback must retain the protected Worker and database
guards. No destructive or automatically permissive database uninstall is supplied.
The break-glass path still requires working Supabase Auth and database services;
it is independent of Google and membership, not an offline bypass.

### Change inventory

| Files | Change |
| --- | --- |
| `src/lib/auth-policy.ts` | Pinned break-glass identity, recognized equal-power roles, access-profile validation |
| `src/lib/portal-client.ts` | Shared authorized API calls, profile checks, and visible error handling |
| `src/lib/supabase.ts`, `src/env.d.ts` | Typed public configuration, Google feature flag, PKCE, shared browser client, existing session key retained |
| `src/pages/admin/login.astro`, `src/pages/auth/callback.astro` | Google option/callback plus preserved password login; authorization before portal entry |
| `src/layouts/AdminLayout.astro`, `src/components/AdminNav.astro` | Typed config, no-store admin responses, role display, explicit logout failures |
| `src/pages/admin/index.astro` | Server-validated access before displaying private dashboard data |
| `src/pages/admin/hui/[id].astro`, `src/pages/admin/hui/new.astro`, `src/components/HuiForm.astro` | Empty/disabled initial form, authorized private-data fetch, preserved edit/create/upload flow |
| `workers/api.ts` | Authorization on every private route; `/api/auth/me` and authorized `GET /api/hui/:id`; no-store responses |
| `migrations/002_trustee_google_auth.sql` | Private membership lookup and additive restrictive policies; no Auth-user changes |
| `migrations/manual/safe_breakglass_fallback.sql` | Non-destructive break-glass-only rollback |
| `tests/auth.test.mjs`, `package.json` | Built-in Node authorization regressions using existing build tooling |
| `.env.example`, `.gitignore`, `README.md` | Default-off rollout flag, private seed exclusion, current architecture/configuration/rollback documentation |

Run `npm test`, `npm run check`, and `npm run build`. Local regression fixtures
must never target production. Browser-mocked OAuth and synthetic PostgreSQL
regressions do not replace a real Google login after production configuration.
