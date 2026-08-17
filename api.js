/* OKKO CAP — API layer.
   With window.OKKO_CONFIG present the site reads live data from Supabase.
   Without it every call resolves to null and index.html keeps using its
   built-in demo data, so the prototype never breaks.                       */
(function () {
  const C = window.OKKO_CONFIG || null;
  const on = !!(C && C.supabaseUrl && C.supabaseAnonKey);

  const rest = (p, q) => `${C.supabaseUrl}/rest/v1/${p}${q ? '?' + q : ''}`;
  const headers = (extra) => Object.assign({
    apikey: C.supabaseAnonKey,
    authorization: `Bearer ${session().access_token || C.supabaseAnonKey}`,
    'content-type': 'application/json',
  }, extra || {});

  function session() { try { return JSON.parse(localStorage.getItem('okko_session') || '{}'); } catch (e) { return {}; } }
  function setSession(s) { localStorage.setItem('okko_session', JSON.stringify(s || {})); }

  async function get(path, query) {
    if (!on) return null;
    const r = await fetch(rest(path, query), { headers: headers() });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function fn(name, body, auth) {
    if (!on) return null;
    const r = await fetch(`${C.functionsUrl}/${name}`, {
      method: 'POST',
      headers: headers(auth && session().access_token ? {} : { authorization: `Bearer ${C.supabaseAnonKey}` }),
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  /* ---- shape the DB rows like the demo objects index.html already renders ---- */
  function toListing(r) {
    return {
      id: r.slug, type: r.type, name: r.name, tag: r.tagline,
      industry: r.industry, loc: r.location, vid: '',
      ask: r.ask, askLabel: r.ask_label, askNote: r.ask_note, chip: r.chip,
      met: r.metrics || [], facts: r.facts || [], fin: r.financials || [],
      terms: r.terms || [], about: r.about || [], model: r.model || [], traction: r.traction || [],
      photos: (r.photos || []).map(media), logo: r.logo_path ? media(r.logo_path) : null,
      documentCount: r.document_count || 0,
    };
  }
  const media = (p) => (p && /^https?:/.test(p) ? p : `${C.mediaUrl}/${p}`);

  window.OKKO = {
    enabled: on,
    media,

    /* ---------------- public ---------------- */
    async listings() {
      const rows = await get('public_listings', 'select=*&order=published_at.desc');
      return rows ? rows.map(toListing) : null;
    },
    async listing(slug) {
      const rows = await get('public_listings', `select=*&slug=eq.${encodeURIComponent(slug)}`);
      return rows && rows[0] ? toListing(rows[0]) : null;
    },
    async documents(slug) {
      const rows = await get('documents',
        `select=id,category,gate,file_name,size_bytes,listings!inner(slug)&listings.slug=eq.${encodeURIComponent(slug)}`);
      return rows;
    },
    trackView: (slug, source, open) => fn('track-view', { slug, source, open }).catch(() => {}),

    /* buyer leaves contacts -> lead + unlocked documents + token */
    submitEnquiry: (payload) => fn('submit-enquiry', payload),
    /* one short-lived download link */
    documentUrl: (document_id, token) => fn('document-url', { document_id, token }),

    /* ---------------- seller ---------------- */
    async signIn(email, password) {
      if (!on) return null;
      const r = await fetch(`${C.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: C.supabaseAnonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error_description || data.msg || 'sign in failed');
      setSession(data);
      return data;
    },
    signOut() { setSession({}); },
    signedIn: () => !!session().access_token,

    myListings: () => get('listings', 'select=*,moderation_notes(body,created_at)&order=created_at.desc'),
    leads: (listingId) => get('leads',
      `select=*,lead_messages(author,body,created_at)&listing_id=eq.${listingId}&order=created_at.desc`),
    async updateLead(id, patch) {
      const r = await fetch(rest('leads', `id=eq.${id}`), {
        method: 'PATCH', headers: headers({ prefer: 'return=representation' }), body: JSON.stringify(patch),
      });
      return r.json();
    },
    async replyToLead(lead_id, body) {
      const r = await fetch(rest('lead_messages'), {
        method: 'POST', headers: headers(), body: JSON.stringify({ lead_id, author: 'seller', body }),
      });
      return r.ok;
    },
    stats: (listingId) => fn('rpc/console_stats', { l_id: listingId }, true),
    views: (listingId) => get('listing_views', `select=day,views,opens&listing_id=eq.${listingId}&order=day.asc`),
    sources: (listingId) => get('view_sources', `select=source,views&listing_id=eq.${listingId}`),
    invoices: () => get('invoices', 'select=*&order=created_at.desc'),

    /* payments */
    checkout: (listing_id, plan) => fn('checkout', { listing_id, plan }, true),
  };
})();
