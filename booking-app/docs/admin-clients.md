# Admin Clients

Open Skyra Booking → Clients. Existing Booking profiles appear automatically;
Sync Shopify clients imports/refreshes 100 Shopify customers at a time, with a
continuation button when more exist. Search matches Shopify name, preferred name
or email. A client name opens their profile, Pass history and 10 latest bookings.
Reports customer names also open the profile; the report dropdown still filters.

Display names use preferred name, then Shopify first + last name, then email,
then “Unnamed client”. Internal UUIDs remain the stable relational identifiers.
Shopify contact data is refreshed in batches on Admin page loads, with a one-hour
cache. Customer profile text and avatars are never overwritten by contact sync.

Pass balances sum immutable ledger deltas. Remaining = available + reserved;
used is consumed credits. The directory totals only active, started, unexpired
Passes with remaining credits. Profiles include expired, revoked, future and
fully used credits, with recorded starts/expiry rather than today's plan terms.

All services require ADMIN/OPERATIONS and an active shop. Customer, Coach and
cross-shop access is rejected. Responses use private/no-store cache headers.
Names/emails stay in Admin responses; existing Customer and Coach APIs keep
explicit field allowlists. Uninstall or removal of read_customers clears the
Shopify name/email cache.

## Shopify permission

The app release adds read_customers. A store owner may need to accept the updated
installation permissions when reopening the app. Skyra Booking must also have
protected customer fields Name and Email selected in the Dev/Partner Dashboard.
If those fields cannot be read, Admin shows an actionable warning while existing
profile data and credit history remain accessible. No invented names or emails.

Client ID: c9d266a38e2f11a1240139974253b3a1
Shopify reference: https://shopify.dev/docs/apps/launch/protected-customer-data

## Verification

`npm test` includes tenant isolation, role checks, contact permission failures,
Shopify import retries, search/pagination, report names and ledger balances.
`npm run check` verifies types, lint and production build. Interactive Chrome
verification uses test fixtures at 1440px and 390px; real installation permissions
and actual Shopify customer data must be verified in the authenticated store.