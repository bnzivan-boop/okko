# Assets

    assets/
      logos/                 petit-paradis.png  like-bricks.png  …   ← company logos
      petit-paradis/         1.jpg 2.jpg 3.jpg …                     ← business photos
      like-bricks/           1.jpg …
      tg-mena/               1.jpg …
      ags-foods/             1.jpg …
        _src/                original files, not used by the site

## Photos

- Folder name = listing id (the `id` field in LISTINGS in index.html).
- `1.jpg` is the cover: catalog card, gallery opener, hero card, seller console.
- `2.jpg`, `3.jpg` … fill the gallery on the deal page, in order. Up to 12.
- jpg / jpeg / png / webp all work; missing numbers are simply skipped.
- Recommended: 16:10, at least 1600 px wide, under ~400 KB per file.

To add photos: drop the files in, then rename them 1.jpg, 2.jpg, … in order.

## Logos

See logos/README.md — one file per listing, named after the listing id.

## Video

Video tours are not shot yet. The placeholder is kept in the code and hidden by
`SHOW_VIDEO = false` in index.html. Set it to `true` when the videos are ready:
the badge returns to the card and the video tile appears last in the gallery,
after the business photos.
