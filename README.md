# Hui Management System

A simple, dignified web application for the **Pehiāweri B1B Ahu Whenua Trust** to publish hui (meeting) notices, Zoom details, and documents — replacing the old workflow of Gmail invitation chains, recurring Google Calendar events, and manually managed Zoom links.

> _oranga whenua · oranga reo_

It is built to be operated by a single, non-technical trustee, and is fully self-contained: once deployed it depends on **no AI service** at runtime.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Tech stack](#tech-stack)
3. [Local development setup](#1-local-development-setup)
4. [Supabase project setup & running the migration](#2-supabase-project-setup--running-the-migration)
5. [Cloudflare Pages + Workers deployment](#3-cloudflare-pages--workers-deployment)
6. [Environment variables](#4-environment-variables)
7. [Creating the first admin user](#5-creating-the-first-admin-user)
8. [For Trustees: How to create a Hui](#6-for-trustees-how-to-create-a-hui)

---

## What it does

- **Public site (`/`)** — shows the next upcoming published hui (title, date, time, location, _Join Zoom_ button, passcode, agenda download, attached documents) and an archive of previous hui. No login required.
- **Admin portal (`/admin`)** — email/password login (Supabase Auth). Create, edit, publish, cancel, and delete hui. Upload an agenda PDF and additional documents. Dashboard lists every hui with its status (draft / published / cancelled).
- **Zoom** — manual only. Trustees paste their own Zoom link and passcode into the form. There is no Zoom API or OAuth.

## Tech stack

| Layer    | Technology                                   |
| -------- | -------------------------------------------- |
| Frontend | Astro (hybrid SSR) + TypeScript + Tailwind   |
| Backend  | Cloudflare Workers + TypeScript              |
| Database | Supabase PostgreSQL                          |
| Auth     | Supabase Auth (email/password, single admin) |
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

   The migration is safe to re-run — it uses `IF NOT EXISTS` and
   `DROP POLICY IF EXISTS` throughout.

> **Note:** This project never applies migrations automatically. You always run
> `001_initial.sql` yourself via the SQL editor.

### What RLS allows

- **Anyone (anonymous):** read **published** hui and their documents, and read
  files in the `hui-documents` bucket.
- **Authenticated (the admin):** full read/write on hui and documents, and
  upload/update/delete files in the bucket.
- The **Cloudflare Worker** uses the **service role** key, which bypasses RLS,
  and performs its own bearer-token auth check on every write request.

---

## 3. Cloudflare Pages + Workers deployment

This app has two deployable parts that share one domain:

- the **Astro site** → Cloudflare **Pages**
- the **API** → a Cloudflare **Worker** routed at `/api/*`

### Current deployment method in this repository

The project is deployed using a split, manual Cloudflare workflow:

1. The frontend/admin Astro app is deployed via **Cloudflare Pages** from the GitHub repository (`npm run build` with `dist` output).
2. The backend API is deployed separately with **Wrangler** using `npm run worker:deploy`.
3. Production traffic expects both parts on the same domain, with the Worker mapped to `/api/*` (via the optional `[[routes]]` block in `wrangler.toml`).
4. Secrets are managed in Cloudflare dashboards/secret stores (Pages environment variables plus Worker secrets), not in source control.

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

> The public homepage and admin edit page are server-rendered and read
> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` at runtime from the Pages
> environment. The browser only ever receives the **anon** key and your
> Supabase URL.

---

## 4. Environment variables

| Variable                    | Used by                 | Secret? | Description                                           |
| --------------------------- | ----------------------- | ------- | ----------------------------------------------------- |
| `SUPABASE_URL`              | Site (SSR) + Worker     | No      | Your Supabase project URL                             |
| `SUPABASE_ANON_KEY`         | Site (browser) + Worker | No      | Public anon key (auth, public reads, Storage uploads) |
| `SUPABASE_SERVICE_ROLE_KEY` | Site (SSR) + Worker     | **Yes** | Service role key — never exposed to the browser       |
| `PUBLIC_API_BASE`           | Site (browser)          | No      | Optional. API base URL. Defaults to `/api`            |

`.env` is read by Astro locally; `.dev.vars` is read by `wrangler dev`. In
production, secrets live in the Cloudflare Pages **and** Worker dashboards. Never
commit real secrets — `.env`, `.env.*`, and `.dev.vars` are git-ignored.

---

## 5. Creating the first admin user

There is no public sign-up. Create the single trustee account by hand:

1. In the Supabase dashboard go to **Authentication → Users → Add user**.
2. Choose **Create new user**, enter the trustee's **email** and a strong
   **password**, and tick **Auto Confirm User** (so no email confirmation is
   required).
3. Click **Create user**.
4. That email/password can now sign in at `/admin/login`.

To add another trustee later, repeat the steps above. To reset a password, use
**Authentication → Users → ⋯ → Send password recovery** or set a new password.

---

## 6. For Trustees: How to create a Hui

This section is written for a non-technical trustee. You only need a web browser.

### Signing in

1. Go to the website and click **Trustee login** at the bottom of the page
   (or go straight to `/admin`).
2. Enter your **email** and **password** and click **Sign in**.

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

- A **Draft** hui is only visible to you. When you are ready for whānau to see it,
  either set the status to **Published** in the form, or click **Publish** next to
  the hui on the dashboard.
- Only the **next upcoming published** hui appears at the top of the public page.
  Past published hui appear in the **Previous Hui** archive.

### Editing or cancelling a hui

- Click **Edit** next to a hui to change any detail or swap out documents.
- Click **Cancel** to mark a hui as cancelled (it stays in the system, shown as
  cancelled). Click **Delete** to remove it permanently — this cannot be undone.

### Signing out

- Click **Sign out** in the top-right of the admin area when you are finished.

That's it — no calendar invites, no email chains, no Zoom admin. Paste your Zoom
link, upload the agenda, and publish.
