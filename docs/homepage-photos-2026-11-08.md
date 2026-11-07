# Homepage photography refresh — 2026-11-08

Updated the local homepage and Shopify homepage section with six photographs supplied by the user. The existing hero and other pages retain their existing images.

| Photograph | File suffix after `skyra-home-` | Display pixels | Placement |
| --- | --- | --- | --- |
| User image 6 | move-together.jpg | 3024 × 4032 | Gallery 1; Class passes |
| User image 3 | aerial-practice.jpg | 4284 × 5712 | Gallery 2; initial centre card |
| User image 8 | find-your-flow.jpg | 4284 × 5712 | Gallery 3; Membership |
| User image 4 | explore-movement.jpg | 4284 × 5712 | Gallery 4 |
| User image 7 | stretch-release.jpg | 2160 × 3840 | Gallery 5 |
| User image 1 | our-studio.jpg | 4032 × 3024 | Gallery 6; Our story |

## Image handling

- Source: user-supplied Skyra studio photographs in this chat; no generated or stock replacements.
- Original files are preserved byte-for-byte locally in `output/home-photo-originals/` (ignored by Git). The supplied source files were not modified.
- Website JPEGs use quality 92 encoding at full original display dimensions. EXIF rotation on images 6 and 8 was normalised. Encoding is lossy; the pixel dimensions and complete rectangular composition are preserved.
- The six website files total approximately 19.3 MB, down from approximately 60.9 MB. They use lazy loading and share URLs across repeated placements. Full-resolution files remain comparatively large on slow connections.
- Matching website assets exist in `assets/site/gallery/` and `shopify-theme/assets/`.

## Layout

- Gallery photos share an image height, with widths derived from their native ratios. Captions sit below the photos. The active photograph fits within the viewport, including the landscape photo on mobile; peripheral cards intentionally overlap and are clipped at the gallery boundary.
- The gallery starts at Aerial practice. Spacing interpolates between image widths during a drag.
- Our story uses the original 4:3 landscape composition. Both membership images use 3:4 portrait compositions, capped at 420 px wide on desktop and stacked with their copy on mobile.
- Images use `object-fit: contain`; membership hover no longer enlarges and crops photos. Small rounded container corners are retained.

## Verification

- Local homepage checked at 1440, 768, 390 and 320 px viewport widths: all six photos cycle, active cards fit, all nine image placements retain their ratios, and no horizontal page overflow occurs.
- Local fixture using the Shopify theme CSS and JavaScript checked at 1440 and 390 px. This is not a live Shopify deployment test.
- Automatic playback, keyboard cycling and mouse dragging verified in Chromium.
- `node --check` passes for both scripts; `git diff --check` passes.
- Browser screenshots are in `output/playwright/home-photos/`.

## Production release

Published on 2026-11-08 at approximately 00:57 AEDT, following the user's explicit approval.

- Store: `mf0n6s-zg.myshopify.com`; public homepage: https://skyrastudio.com.au/.
- Confirmed live theme: `155942944935`, **Skyra Website – Managed**.
- Uploaded the six `assets/skyra-home-*.jpg` assets first, then `assets/skyra.css`, `assets/skyra-site.js` and `sections/skyra-home.liquid`. Both pushes used an explicit file allowlist, `--allow-live` and `--nodelete`.
- Before publishing, downloaded the three live code files to `tmp/home-photos-live-before/`. Live CSS and homepage Liquid contained a newer WeChat footer update; merged and preserved it. The existing `skyra-footer-wechat.liquid` and `skyra-wechat-qr.jpg` dependencies were downloaded into the local theme for consistency and were not republished.
- Read back the three published code files into `tmp/home-photos-live-after/` and verified their contents match the final local versions.
- Theme Check passed with no errors. Six existing warnings remain in unrelated `header.liquid` and `divider.liquid` files.

### Live verification

- Loaded the public production URL without a preview-theme parameter. HTTP 200 and runtime theme ID `155942944935` confirmed.
- Checked desktop at 1440 px and Chromium touch/mobile emulation at 390 px and 320 px. These are browser checks, not physical-device testing.
- All six gallery images loaded from the production CDN with the exact full-resolution dimensions listed above. All nine image placements retained their aspect ratios. Each of the six active cards fit the viewport, including the landscape studio image.
- No horizontal page overflow; WeChat footer retained; no JavaScript page errors during the checks.
- Verified automatic playback, desktop mouse dragging, keyboard cycling and simulated mobile touch swiping against the live site.
- Reviewed live screenshots in `output/playwright/home-photos-live/`, including desktop/mobile gallery, story and membership views.
