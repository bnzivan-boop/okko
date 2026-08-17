# OKKO CAP — backend

Postgres + Auth + file storage + a handful of edge functions on **Supabase**,
payments on **Stripe**, transactional email on **Resend**. The site stays the
static single page it is today and talks to this over HTTPS — no server to run,
no container to babysit.

    schema.sql              tables, enums, triggers, the public_listings view
    policies.sql            row level security + storage buckets
    rpc.sql                 counters, NDA signing, console stats
    functions/
      submit-enquiry/       buyer leaves contacts → lead + docs unlocked + emails
      document-url/         60-second signed URL for one gated file
      checkout/             Stripe Checkout + webhook (listing fee)
      track-view/           daily view counters
    seed/seed.mjs           imports the four demo listings, photos and logos

## What lives where

| Data | Table | Who can read it |
|---|---|---|
| Listings, photos, terms | `listings`, `listing_media` | anyone, once `status = 'live'` |
| Documents (files) | private `documents` bucket | only via a signed URL from `document-url` |
| Document list + lock state | `documents` | anyone (so buyers see what is locked) |
| Buyer contacts, messages | `leads`, `lead_messages` | the listing owner, their team, admins |
| NDAs, downloads | `nda_signatures`, `document_downloads` | the listing owner, admins |
| Views, sources | `listing_views`, `view_sources` | the listing owner, admins |
| Plans, invoices | `subscriptions`, `invoices` | the owner, admins |

Everything is denied by default; `policies.sql` is the complete list of ways data
can leave the database.

## Deploy

    # 1. Supabase
    npm i -g supabase
    supabase login
    supabase link --project-ref <ref>
    psql "$DATABASE_URL" -f schema.sql -f policies.sql -f rpc.sql

    # 2. Secrets (from backend/.env.local)
    supabase secrets set --env-file .env.local

    # 3. Functions
    supabase functions deploy submit-enquiry --no-verify-jwt
    supabase functions deploy document-url   --no-verify-jwt
    supabase functions deploy track-view     --no-verify-jwt
    supabase functions deploy checkout

    # 4. Demo content
    cd seed && npm i @supabase/supabase-js && node seed.mjs

    # 5. Stripe webhook → https://<ref>.functions.supabase.co/checkout/webhook
    #    events: checkout.session.completed, invoice.paid, customer.subscription.deleted

## Frontend

`index.html` reads `window.OKKO_CONFIG` (see `config.example.js`). With no config
it runs on the built-in demo data exactly as it does today, so the prototype
never breaks while the backend is being set up.

## Domain

Point the domain at the host that serves `index.html` (Vercel, Netlify, Cloudflare
Pages — all free for this). DNS records are in the root README.
