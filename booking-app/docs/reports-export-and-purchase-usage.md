# Reports export and purchase usage

## Diagnosis and fix
The previous reloadDocument links navigated the Shopify embedded frame to the protected export resource without the App Bridge bearer token or shop/host query. The installed Shopify auth SDK responds to that document request with an App Bridge authentication HTML shell, explaining the reported blank content. This was traced through local code; the failing production request has not been captured.

Exports now use App Bridge-patched global fetch, verify status/content type/nonempty payload, and download a Blob attachment. Failures remain visible inline and do not navigate away. Authentication and staff authorization remain enforced server-side.

## Reporting rules
- Filter purchases from the start day through the end day in the shop timezone. Usage includes ledger entries strictly before the next day; future cutoff is capped at report generation time.
- One row per recorded purchase: customer, purchase date, course/pass, purchase amount, purchased/used/remaining classes, unit price, source and reference.
- Sources: membership receipts, booking online checkout snapshots, manual Cash grant audit records. Deduplicate membership receipts against booking results for the same shop/order/line.
- Use original recorded amount and credits, never editable catalogue price. Unit price is amount / purchased credits, rounded to two decimals for CSV.
- Used is net consumed ledger credits (including restores). Remaining is available plus reserved ledger credits as of cutoff. Adjustments/revocations can change the balance. Expired and exhausted passes are retained; balance does not imply current usability.
- Payment timestamps are used where stored; otherwise the row explicitly identifies its recorded-date fallback. Missing prices/credits and unlinked balances are labelled, not inferred.
- Refunds and unrecorded/imported historical payments are NOT included. This is an operational purchase/usage export, not a complete tax reconciliation.
- Booking online amounts come from checkout snapshots. Historical UAT discounts can make these differ from actual payments; the CSV identifies the amount basis and the page requires payment reconciliation. Membership receipts use the recorded paid amount; Cash uses the manually entered amount.
- Existing unused-pass report remains today's active balance. Existing type=both stays two files; type=all adds the new purchase CSV as a third ZIP entry.

## Validation
Dedicated skyra_booking_test database only. Tests: booking-reports, report-exports, report-client-search, purchase-usage-report, report-download (19 tests). Typecheck, focused ESLint, production build.

scripts/reports-download-smoke.mjs exercises the hydrated component in Chrome at 390, 768 and 1440px: HTML authentication response shows an inline error, retry downloads real CSV, ZIP contains three files, selected filters are preserved, no navigation/page errors/page overflow. Set PLAYWRIGHT_MODULE if Playwright is installed outside this package. App Bridge and production authentication are not mocked as proof of live verification.

No production records were changed and no migration is required. Release still needs deployment and a real authenticated Shopify Admin export check.
