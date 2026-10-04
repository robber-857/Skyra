# Published classes open for booking immediately

The approved policy is now live: a `PUBLISHED` class opens for booking immediately,
without waiting until 14 days before its start. The existing two-hour cutoff,
capacity/seat holds, eligible Pass checks, approved rules and shop release gates
remain enforced. Stored `rules.bookingWindowDays=14` is ignored; no database
migration is required. Staff booking also no longer limits available sessions to
the next 15 days.

## Release

- Code: [`106966e`](https://github.com/robber-857/Skyra/commit/106966eed4c54217e76838d9c0d4c5b05697fab9), pushed to `bookingdev` from an isolated worktree.
- Render: `dep-db0u03mq1p3s73enn8q0`, `live` at 2026-10-04 16:14 Australia/Sydney, running the code commit above.
- Shopify: [`skyra-publish-booking-20261004`](https://dev.shopify.com/dashboard/232832637/apps/420648878081/versions/1153929969665), released after the backend became live.
- The release excludes the original checkout's uncommitted membership work, schema changes, and new membership extension.

## Verification

- Clean release worktree: 58 test files / 599 tests passed against `skyra_booking_test`; type checks, lint, Web and Worker builds passed; 8 Mindbody Python tests passed.
- [GitHub CI](https://github.com/robber-857/Skyra/actions/runs/37179174790) passed all steps, including fresh-database migrations, full tests, both builds and Python tests.
- Shopify configuration validation, theme check, extension bundling and release succeeded.
- At 2026-10-04 16:16 Australia/Sydney, [October 24 public schedule](https://skyrastudio.com.au/apps/skyra-booking/sessions?from=2026-10-24&to=2026-10-24) returned the same 5 published session IDs, times and capacity as before release, with every status changed from `NOT_YET_OPEN` to `OPEN`.
- Home and Programs both loaded the new Shopify extension version. Live `booking.js` and `calendar.js` no longer contain the 14-day opening copy.
- Fresh headless Chrome at 390px and 1440px visited live Programs and selected October 24 through the calendar. All 5 `Book` buttons were enabled, the rendered view contained no 14-day copy, and no page errors occurred. No `Book` button was clicked; there were no booking POST requests. Screenshots and accessibility snapshots are saved locally under `output/playwright/booking-publish-immediate/`.
- Today's 17:45 class still returned `BOOKING_CLOSED` within two hours of its start; the 20:00 class remained `OPEN`.
- [Backend health](https://skyra-booking-web.onrender.com/health) returned HTTP 200 with `status=ok`.

These checks did not create a production booking or payment and do not replace
authenticated customer booking/payment UAT.
