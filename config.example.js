// Copy to config.js next to index.html and fill in.  index.html loads it if it
// exists; without it the site runs on the built-in demo data.
//
// Only public keys go here — the anon key is safe in the browser because row
// level security decides what it may read. The service_role key must NEVER
// appear in this file.

window.OKKO_CONFIG = {
  supabaseUrl: 'https://xxxxxxxxxxxx.supabase.co',
  supabaseAnonKey: 'eyJ...',
  functionsUrl: 'https://xxxxxxxxxxxx.functions.supabase.co',
  // Public bucket base — where photos and logos are served from.
  mediaUrl: 'https://xxxxxxxxxxxx.supabase.co/storage/v1/object/public/public-media',
};
