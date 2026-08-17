# News covers

One image per article, named after its slug:

    assets/news/uae-sme-deals-h1-2026.jpg
    assets/news/video-tour-sells-faster.jpg
    assets/news/raising-for-a-branch-not-a-company.jpg
    assets/news/due-diligence-checklist-uae.jpg
    assets/news/okko-cap-launch.jpg

- jpg / jpeg / png / webp all work.
- 16:10 or wider, at least 1600 px, under ~400 KB. The article page crops the
  cover to 21:9, so keep the subject in the middle.
- No file? A generated gradient cover is used, so nothing breaks.

Slugs live in the NEWS array in index.html — they are also the URL of the piece
(`#/news/<slug>`).
