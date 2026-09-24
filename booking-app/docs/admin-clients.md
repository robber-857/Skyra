# Admin Clients

Open Skyra Booking → Clients. Existing Booking profiles appear automatically;
Sync all Shopify customers automatically imports/refreshes successive batches of
100 with one click, showing a cumulative count until all batches finish. Keep the
page open during syncing. A failed batch can be retried from its cursor without
repeating completed batches. Leaving or reloading the page resets progress; a new
sync safely upserts existing customers. Search matches Shopify name, preferred name
or email. A client name opens their profile, Pass history and 10 latest bookings.
Reports customer names also open the profile; the report dropdown still filters.
Directory pages show 10 clients, with Previous/Next, current / total page count
and a page jump. Page and search are URL parameters, retained on refresh.

Client detail Passes & class credits show 5 items per page, with Previous/Next,
current / total pages and a page jump. The passPage URL parameter survives refresh.
Customer Account My passes uses the same 5-item numbered API, restoring its tab
and page from Shopify navigation entry state on refresh. Legacy cursor clients
and the Overview summary keep their existing 25-item API contract.

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

Add client creates a Shopify customer from first name, optional last name and
email, or links the existing exact email match. It opens the resulting Booking
profile and preserves existing profile content. Creating customers requires
write_customers in both the app release and runtime scopes; the owner may need
to approve the updated installation permissions.

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
