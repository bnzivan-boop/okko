// Seeds the database from the prototype: four listings, their photos, logos and
// document placeholders. Run once after the schema is in place.
//
//   cd backend/seed
//   npm i @supabase/supabase-js
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SEED_OWNER_EMAIL=you@okkocap.com node seed.mjs
//
// Idempotent: listings are matched by slug, media by path.

import { createClient } from '@supabase/supabase-js';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OWNER = process.env.SEED_OWNER_EMAIL;
if (!URL || !KEY || !OWNER) {
  console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SEED_OWNER_EMAIL');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });
const ROOT = path.resolve('../..');            // repo root
const ASSETS = path.join(ROOT, 'assets');

// ---------------------------------------------------------------- owner
async function owner() {
  const { data } = await db.auth.admin.listUsers();
  const found = data.users.find((u) => u.email === OWNER);
  if (found) return found.id;
  const { data: made, error } = await db.auth.admin.createUser({
    email: OWNER, email_confirm: true, user_metadata: { full_name: 'OKKO CAP' },
  });
  if (error) throw error;
  console.log('created user', OWNER, '— send a password reset to sign in');
  return made.user.id;
}

// ---------------------------------------------------------------- listings
// Pulled straight out of index.html so the two never drift.
async function listingsFromPrototype() {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const start = html.indexOf('const LISTINGS = [');
  const end = html.indexOf('\n];', start);
  const literal = html.slice(start + 'const LISTINGS = '.length, end + 2);
  return eval(literal); // trusted local file
}

async function upload(bucket, key, file, contentType) {
  const body = await readFile(file);
  const { error } = await db.storage.from(bucket).upload(key, body, { contentType, upsert: true });
  if (error && !/exists/i.test(error.message)) throw error;
  return key;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

async function run() {
  const ownerId = await owner();
  const listings = await listingsFromPrototype();

  for (const l of listings) {
    // logo -> company
    let logoPath = null;
    for (const ext of ['png', 'svg', 'jpg', 'webp']) {
      const f = path.join(ASSETS, 'logos', `${l.id}.${ext}`);
      if (existsSync(f)) { logoPath = await upload('public-media', `logos/${l.id}.${ext}`, f, MIME['.' + ext]); break; }
    }

    const { data: company } = await db.from('companies')
      .upsert({ owner_id: ownerId, legal_name: l.name, logo_path: logoPath }, { onConflict: 'legal_name' })
      .select('id').single();

    const { data: listing } = await db.from('listings').upsert({
      slug: l.id, owner_id: ownerId, company_id: company?.id,
      type: l.type, status: 'live',
      name: l.name, tagline: l.tag, industry: l.industry, location: l.loc,
      ask: l.ask, ask_label: l.askLabel, ask_note: l.askNote, chip: l.chip,
      metrics: l.met, facts: l.facts, financials: l.fin, terms: l.terms,
      about: l.about, model: l.model, traction: l.traction,
      completeness: 100, published_at: new Date().toISOString(),
    }, { onConflict: 'slug' }).select('id').single();

    // photos
    const dir = path.join(ASSETS, l.id);
    if (existsSync(dir)) {
      const files = (await readdir(dir))
        .filter((f) => /^\d+\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort((a, b) => parseInt(a) - parseInt(b));
      let pos = 0;
      for (const f of files) {
        const key = await upload('public-media', `${l.id}/${f}`, path.join(dir, f), MIME[path.extname(f).toLowerCase()]);
        await db.from('listing_media').upsert(
          { listing_id: listing.id, kind: 'photo', path: key, position: pos },
          { onConflict: 'path' },
        );
        if (pos === 0) await db.from('listings').update({ cover_path: key }).eq('id', listing.id);
        pos++;
      }
      console.log(`${l.id}: ${files.length} photos`);
    }

    // document slots — real files are uploaded by the seller in the console
    const docs = [
      { category: 'deck',       gate: 'public',   file_name: `Teaser — ${l.name}.pdf` },
      { category: 'deck',       gate: 'contacts', file_name: 'Full presentation.pptx' },
      { category: 'financials', gate: 'contacts', file_name: 'P&L by month, last 12 months.xlsx' },
      { category: 'legal',      gate: 'nda',      file_name: 'Trade licence & lease.pdf' },
    ];
    for (const d of docs) {
      await db.from('documents').upsert({
        listing_id: listing.id, ...d, storage_path: `${l.id}/${d.file_name}`,
      }, { onConflict: 'listing_id,file_name' });
    }
  }

  console.log('done');
}

run().catch((e) => { console.error(e); process.exit(1); });
