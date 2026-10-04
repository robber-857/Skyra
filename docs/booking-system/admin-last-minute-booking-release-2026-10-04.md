# Online cutoff notice and Admin last-minute booking

Booking now displays: “Online booking closes 2 hours before class. For last-minute bookings, please contact the studio.” The notice is visible in the shared header on the schedule, class details and booking flow.

Authenticated `ADMIN` users can book a published class for a client until its start through **Clients → client details → Book a class**. This includes the final two hours, while customer and `OPERATIONS` bookings retain the two-hour cutoff. At the exact class start and afterward, new bookings are closed. Classes still open immediately after publication; the removed 14-day restriction remains absent.

The exception is derived from the authenticated staff actor in both session selection and booking submission. Request fields cannot enable it. Publication, approved rules, active service/coach, capacity including live holds, eligible Pass ownership/balance, duplicate protection, transaction locks, idempotency, notifications and audit logging remain enforced. A successful request retried after the class starts still returns its original booking without another credit reservation. Existing rescheduling and past-attendance recording retain their separate rules. No database migration is needed.

## Release

- Code: [`7d83030`](https://github.com/robber-857/Skyra/commit/7d83030da472aaf7f09be470b85a633b2730c886), pushed to `bookingdev` from an isolated managed worktree.
- Render: `dep-db0ubrdg1s2s73939ss0`, `live` at 2026-10-04 16:39 Australia/Sydney, running the code commit above.
- Shopify: [`skyra-admin-late-booking-20261004`](https://dev.shopify.com/dashboard/232832637/apps/420648878081/versions/1153937932289), released after the backend became live. The first release request encountered `ECONNRESET`; the version was verified inactive before retrying successfully.
- Only the eight booking-related source, asset and test files were released. Unrelated membership work, schema changes and the new membership extension were excluded.

## Verification

- Dedicated local test database: 61 targeted booking tests passed; complete release suite passed 58 files / 608 tests, plus 8 Mindbody Python tests.
- Type checks, customer extension type checks, lint, Web build and Worker build passed. Shopify app configuration validation, theme check, extension bundling and release succeeded. Generated `booking.js` is 9,984 bytes, below the extension asset limit.
- [GitHub CI](https://github.com/robber-857/Skyra/actions/runs/37180396878) passed all steps, including migrations against a fresh database and the full release checks.
- Local browser fixtures verified Home and Programs at 390px and 1440px: notice visible in schedule/details, closed/full buttons disabled, open button enabled, no horizontal overflow or page errors. Evidence: `output/playwright/booking-cutoff-notice/`.
- Live public schedule at 2026-10-04 16:41 Australia/Sydney: the 17:45 class remained `BOOKING_CLOSED`, while 20:00 remained `OPEN`. All five October 24 classes remained `OPEN`.
- Fresh live Chrome at 2026-10-04 16:46 Australia/Sydney verified Home and Programs at 390px and 1440px. All four views loaded the new Shopify CDN version, displayed the notice in schedule/details, preserved today's closed/open buttons and October 24's five enabled Book buttons, and had no overflow, old 14-day text or page errors. Evidence: `output/playwright/admin-late-booking-live/`. No Book/Continue button was clicked and no booking-app POST was attempted; passive Shopify POSTs were intercepted locally to keep the check read-only.
- Backend `/health` returned HTTP 200 with `{"status":"ok"}`.

These checks do not create a production booking or payment. The Admin exception is verified by local database integration tests and the exact deployed commit; authenticated production Admin booking UAT remains separate.
