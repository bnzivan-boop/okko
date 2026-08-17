# OKKO CAP — marketplace prototype

A single-file prototype of the OKKO CAP marketplace: businesses for sale and
companies raising capital in the Gulf.

    index.html          the whole app — markup, styles, data and hash router
    assets/logos/       brand and company logos
    assets/<listing>/   business photos, 1.jpg is the cover

## Run it

Any static server works:

    python3 -m http.server 8899

Then open http://localhost:8899

## Pages

- `#/` home — hero, statement, live deals, pricing
- `#/market` catalog with filters and search
- `#/deal/<id>` deal page — photo gallery, financials, terms, gated documents
- `#/list` five-step listing wizard (basics, numbers, media & documents, payment)
- `#/login` sign in
- `#/account` seller console — overview, enquiries, listings, analytics,
  documents, billing, settings
- `#/advisory` OKKO Capital mandates

## Content

- Listings live in the `LISTINGS` array in index.html.
- Photos: `assets/<listing-id>/1.jpg, 2.jpg …` — see assets/README.md.
- Logos: `assets/logos/<listing-id>.png` and `assets/logos/okko-cap.svg`.
- Video tours are not shot yet: `SHOW_VIDEO = false` hides the placeholders.
